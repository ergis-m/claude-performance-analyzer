import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import dashboard from "./dashboard/index.html";
import { openStore } from "./db";
import { parseLogs, parseMetrics, parseTraces, type EventRow } from "./otlp";
import { liveEvent, status, summarize } from "./analytics";
import { applyEnv, planEnv, settingsPath, telemetryEnv } from "./settings";

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

function ingest<T>(parse: (b: any) => T[], save: (rows: T[]) => void, onSaved?: (rows: T[]) => void) {
  return async (req: Request) => {
    try {
      const rows = parse(await readOtlp(req));
      save(rows);
      onSaved?.(rows);
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

// Push new events to open dashboards so they update without polling.
function broadcast(rows: EventRow[]) {
  const events = rows.map(liveEvent).filter((e) => e !== null);
  server.publish("live", JSON.stringify({ type: "events", events, changed: rows.length }));
}

function recentLive(limit: number) {
  return store
    .events(Date.now() - 3600_000)
    .map(liveEvent)
    .filter((e) => e !== null)
    .slice(-limit)
    .reverse();
}

// The setup endpoint writes user settings, so only our own page may call it.
// Host blocks DNS rebinding; Origin blocks cross-site form posts.
function isOwnPage(req: Request): boolean {
  const own = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin") ?? "";
  return own.includes(host) && own.some((h) => origin === `http://${h}`) && (req.headers.get("content-type") ?? "").includes("application/json");
}

function setup(req: Request) {
  const wanted = telemetryEnv(PORT);
  if (req.method === "GET") return Response.json(planEnv(settingsPath(), wanted));
  if (!isOwnPage(req)) return new Response("Forbidden", { status: 403 });
  try {
    const result = applyEnv(settingsPath(), wanted);
    console.log(`settings: added ${result.added.join(", ") || "nothing"}${result.backup ? `, backup ${result.backup}` : ""}`);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/": dashboard,
    "/v1/logs": { POST: ingest(parseLogs, store.addEvents, broadcast) },
    "/v1/traces": { POST: ingest(parseTraces, store.addSpans) },
    "/v1/metrics": { POST: ingest(parseMetrics, store.addMetrics) },
    "/api/summary": (req) => Response.json(summaryFor(windowFrom(new URL(req.url)))),
    "/api/status": () => Response.json(status(summaryFor(15 * 60_000))),
    "/api/live": () => Response.json(recentLive(60)),
    "/api/setup": { GET: setup, POST: setup },
    "/ws": (req, srv) => (srv.upgrade(req) ? undefined : new Response("WebSocket upgrade required", { status: 426 })),
  },
  websocket: {
    open: (ws) => {
      ws.subscribe("live");
    },
    message: () => {},
  },
  development: process.env.NODE_ENV !== "production" ? { hmr: false, console: true } : false,
});

console.log(`claude telemetry collector on ${server.url} (data: ${DATA_DIR})`);
