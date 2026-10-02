// Decodes OTLP http/protobuf bodies into the same object shape as OTLP http/json.
import protobuf from "protobufjs";
import { join } from "node:path";

const PROTO_DIR = join(import.meta.dir, "..", "proto");
const SERVICES = {
  logs: ["opentelemetry/proto/collector/logs/v1/logs_service.proto", "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"],
  metrics: ["opentelemetry/proto/collector/metrics/v1/metrics_service.proto", "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest"],
  traces: ["opentelemetry/proto/collector/trace/v1/trace_service.proto", "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"],
} as const;
export type Signal = keyof typeof SERVICES;

let root: protobuf.Root | null = null;
function load(): protobuf.Root {
  if (root) return root;
  const r = new protobuf.Root();
  r.resolvePath = (_origin, target) => join(PROTO_DIR, target);
  r.loadSync(Object.values(SERVICES).map(([file]) => file));
  return (root = r);
}

export function requestType(signal: Signal): protobuf.Type {
  return load().lookupType(SERVICES[signal][1]);
}

// OTLP/JSON writes trace and span ids as hex; protobuf carries raw bytes.
const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);
function hexIds(value: any): any {
  if (Array.isArray(value)) return value.map(hexIds);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (ID_FIELDS.has(k) && typeof v === "string") value[k] = Buffer.from(v, "base64").toString("hex");
      else hexIds(v);
    }
  }
  return value;
}

export function decodeOtlp(signal: Signal, bytes: Uint8Array): any {
  const type = requestType(signal);
  return hexIds(type.toObject(type.decode(bytes), { longs: String, enums: Number, bytes: String, defaults: false }));
}
