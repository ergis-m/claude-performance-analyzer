import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import dashboard from "./dashboard/index.html";
import { openStore } from "./db";
import { parseLogs, parseMetrics, parseTraces } from "./otlp";
import { status, summarize } from "./analytics";

const PORT = Number(process.env.PORT ?? 4318);
const DATA_DIR = process.env.CC_TELEMETRY_DIR ?? `${homedir()}/.claude-telemetry`;
const RETENTION_MS = 14 * 24 * 3600_000;

mkdirSync(DATA_DIR, { recursive: true });
const store = openStore(`${DATA_DIR}/telemetry.sqlite`);
store.prune(Date.now() - RETENTION_MS);
setInterval(() => store.prune(Date.now() - RETENTION_MS), 3600_000);

async function readOtlp(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("protobuf")) {
    throw new Response("Only OTLP http/json is supported. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json", { status: 415 });
  }
  let bytes = new Uint8Array(await req.arrayBuffer());
  if (req.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function ingest<T>(parse: (b: any) => T[], save: (rows: T[]) => void) {
  return async (req: Request) => {
    try {
      const rows = parse(await readOtlp(req));
      save(rows);
      return Response.json({});
    } catch (err) {
      if (err instanceof Response) return err;
      console.error("ingest failed:", err);
      return new Response(String(err), { status: 400 });
    }
  };
}

function windowFrom(url: URL): number {
  const minutes = Number(url.searchParams.get("minutes") ?? 60);
  return Math.min(Math.max(minutes, 5), 14 * 24 * 60) * 60_000;
}

function summaryFor(windowMs: number) {
  const since = Date.now() - windowMs;
  return summarize(store.events(since), store.spans(since), windowMs);
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/": dashboard,
    "/v1/logs": { POST: ingest(parseLogs, store.addEvents) },
    "/v1/traces": { POST: ingest(parseTraces, store.addSpans) },
    "/v1/metrics": { POST: ingest(parseMetrics, store.addMetrics) },
    "/api/summary": (req) => Response.json(summaryFor(windowFrom(new URL(req.url)))),
    "/api/status": () => Response.json(status(summaryFor(15 * 60_000))),
  },
  development: process.env.NODE_ENV !== "production" ? { hmr: false, console: true } : false,
});

console.log(`claude telemetry collector on ${server.url} (data: ${DATA_DIR})`);
