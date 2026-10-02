import { Database } from "bun:sqlite";
import type { EventRow, MetricRow, SpanRow } from "./otlp";

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS events (
    ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, prompt_id TEXT, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS events_ts ON events (ts_ms)");
  db.run(`CREATE TABLE IF NOT EXISTS spans (
    trace_id TEXT, span_id TEXT, parent_id TEXT, name TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_id TEXT, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS spans_start ON spans (start_ms)");
  db.run(`CREATE TABLE IF NOT EXISTS metrics (
    ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, value REAL NOT NULL, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS metrics_ts ON metrics (ts_ms)");

  const insEvent = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)");
  const insSpan = db.prepare("INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insMetric = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, ?)");

  const addEvents = db.transaction((rows: EventRow[]) => {
    for (const r of rows) insEvent.run(r.tsMs, r.name, r.sessionId, r.promptId, JSON.stringify(r.attrs));
  });
  const addSpans = db.transaction((rows: SpanRow[]) => {
    for (const r of rows)
      insSpan.run(r.traceId, r.spanId, r.parentId, r.name, r.startMs, r.endMs, r.sessionId, JSON.stringify(r.attrs));
  });
  const addMetrics = db.transaction((rows: MetricRow[]) => {
    for (const r of rows) insMetric.run(r.tsMs, r.name, r.sessionId, r.value, JSON.stringify(r.attrs));
  });

  return {
    db,
    addEvents,
    addSpans,
    addMetrics,
    events(sinceMs: number): EventRow[] {
      return db
        .query("SELECT ts_ms, name, session_id, prompt_id, attrs FROM events WHERE ts_ms >= ? ORDER BY ts_ms")
        .all(sinceMs)
        .map((r: any) => ({
          tsMs: r.ts_ms,
          name: r.name,
          sessionId: r.session_id,
          promptId: r.prompt_id,
          attrs: JSON.parse(r.attrs),
        }));
    },
    spans(sinceMs: number): SpanRow[] {
      return db
        .query("SELECT * FROM spans WHERE start_ms >= ? ORDER BY start_ms")
        .all(sinceMs)
        .map((r: any) => ({
          traceId: r.trace_id,
          spanId: r.span_id,
          parentId: r.parent_id,
          name: r.name,
          startMs: r.start_ms,
          endMs: r.end_ms,
          sessionId: r.session_id,
          attrs: JSON.parse(r.attrs),
        }));
    },
    prune(olderThanMs: number) {
      db.run("DELETE FROM events WHERE ts_ms < ?", [olderThanMs]);
      db.run("DELETE FROM spans WHERE start_ms < ?", [olderThanMs]);
      db.run("DELETE FROM metrics WHERE ts_ms < ?", [olderThanMs]);
    },
  };
}
