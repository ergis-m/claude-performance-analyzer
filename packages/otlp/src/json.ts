// Flattens OTLP http/json payloads into plain rows.

export type Attrs = Record<string, unknown>;

export interface EventRow {
  tsMs: number;
  name: string;
  sessionId: string | null;
  promptId: string | null;
  attrs: Attrs;
}

export interface SpanRow {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  sessionId: string | null;
  attrs: Attrs;
}

export interface MetricRow {
  tsMs: number;
  name: string;
  sessionId: string | null;
  value: number;
  attrs: Attrs;
}

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};
type KeyValue = { key: string; value?: AnyValue };

function anyValue(v: AnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return kvList(v.kvlistValue.values);
  return null;
}

function kvList(list: KeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of list ?? []) out[kv.key] = anyValue(kv.value);
  return out;
}

// Nanosecond strings overflow float precision, but millisecond resolution is enough here.
function nanosToMs(n: string | number | undefined): number {
  if (n === undefined || n === null) return 0;
  return Math.floor(Number(n) / 1e6);
}

function str(v: unknown): string | null {
  return v === undefined || v === null || v === "" ? null : String(v);
}

export function parseLogs(body: any): EventRow[] {
  const rows: EventRow[] = [];
  for (const rl of body?.resourceLogs ?? []) {
    const resource = kvList(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = { ...resource, ...kvList(rec.attributes) };
        const bodyName = anyValue(rec.body);
        const rawName = str(attrs["event.name"]) ?? (typeof bodyName === "string" ? bodyName : "unknown");
        const name = rawName.replace(/^claude_code\./, "");
        let tsMs = nanosToMs(rec.timeUnixNano) || nanosToMs(rec.observedTimeUnixNano);
        const iso = attrs["event.timestamp"];
        if (typeof iso === "string" && !Number.isNaN(Date.parse(iso))) tsMs = Date.parse(iso);
        if (!tsMs) tsMs = Date.now();
        rows.push({
          tsMs,
          name,
          sessionId: str(attrs["session.id"]),
          promptId: str(attrs["prompt.id"]),
          attrs,
        });
      }
    }
  }
  return rows;
}

export function parseTraces(body: any): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const rs of body?.resourceSpans ?? []) {
    const resource = kvList(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = { ...resource, ...kvList(span.attributes) };
        rows.push({
          traceId: String(span.traceId ?? ""),
          spanId: String(span.spanId ?? ""),
          parentId: str(span.parentSpanId),
          name: String(span.name ?? "unknown"),
          startMs: nanosToMs(span.startTimeUnixNano),
          endMs: nanosToMs(span.endTimeUnixNano),
          sessionId: str(attrs["session.id"]),
          attrs,
        });
      }
    }
  }
  return rows;
}

export function parseMetrics(body: any): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const rm of body?.resourceMetrics ?? []) {
    const resource = kvList(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        const data = metric.sum ?? metric.gauge;
        // Histograms are not emitted by Claude Code today; skip rather than guess a value.
        if (!data) continue;
        for (const dp of data.dataPoints ?? []) {
          const attrs = { ...resource, ...kvList(dp.attributes) };
          const value = dp.asDouble !== undefined ? Number(dp.asDouble) : Number(dp.asInt ?? 0);
          rows.push({
            tsMs: nanosToMs(dp.timeUnixNano) || Date.now(),
            name: String(metric.name).replace(/^claude_code\./, ""),
            sessionId: str(attrs["session.id"]),
            value,
            attrs,
          });
        }
      }
    }
  }
  return rows;
}
