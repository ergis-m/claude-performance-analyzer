import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOtlp, requestType } from "../src/otlp-proto";
import { parseLogs, parseMetrics, parseTraces } from "../src/otlp";

const s = (v: string) => ({ stringValue: v });
const NOW_NS = "1790942400000000000";
const logs = {
  resourceLogs: [{
    resource: { attributes: [{ key: "service.name", value: s("claude-code") }] },
    scopeLogs: [{ logRecords: [{
      timeUnixNano: NOW_NS,
      body: s("claude_code.tool_result"),
      attributes: [
        { key: "event.name", value: s("tool_result") },
        { key: "prompt.id", value: s("p-9") },
        { key: "duration_ms", value: { intValue: "812" } },
        { key: "cost_usd", value: { doubleValue: 0.25 } },
        { key: "ok", value: { boolValue: true } },
      ],
    }] }],
  }],
};
const encode = (signal: "logs" | "metrics" | "traces", obj: any) => {
  const t = requestType(signal);
  return t.encode(t.fromObject(obj)).finish();
};

test("protobuf logs decode to the same rows as OTLP/JSON", () => {
  expect(parseLogs(decodeOtlp("logs", encode("logs", logs)))).toEqual(parseLogs(logs));
});

test("protobuf span ids decode to hex like OTLP/JSON", () => {
  const traceId = "5b8efff798038103d269b633813fc60c";
  const spanId = "eee19b7ec3c1b174";
  const pb = {
    resourceSpans: [{ scopeSpans: [{ spans: [{
      traceId: Buffer.from(traceId, "hex"), spanId: Buffer.from(spanId, "hex"),
      name: "claude_code.llm_request", startTimeUnixNano: NOW_NS, endTimeUnixNano: "1790942401000000000",
      attributes: [{ key: "ttft_ms", value: { intValue: "640" } }],
    }] }] }],
  };
  const [span] = parseTraces(decodeOtlp("traces", encode("traces", pb)));
  expect(span).toMatchObject({ traceId, spanId, name: "claude_code.llm_request", endMs: 1790942401000 });
  expect(span!.attrs.ttft_ms).toBe(640);
});

test("protobuf metrics decode sums", () => {
  const pb = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "claude_code.cost.usage", sum: { dataPoints: [{ timeUnixNano: NOW_NS, asDouble: 1.5 }] } }] }] }] };
  expect(parseMetrics(decodeOtlp("metrics", encode("metrics", pb)))).toMatchObject([{ name: "cost.usage", value: 1.5 }]);
});

const PORT = 16000 + Math.floor(Math.random() * 1000);
let proc: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-pb-"));
  proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), CC_TELEMETRY_DIR: dir, CC_SETTINGS_PATH: join(dir, "settings.json"), NODE_ENV: "production" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/live`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});
afterAll(() => proc.kill());

test("server accepts http/protobuf, plain and gzipped", async () => {
  // /api/live only covers the last hour, so stamp the record with the current time.
  const fresh = structuredClone(logs);
  fresh.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.timeUnixNano = `${Date.now()}000000`;
  const body = new Uint8Array(encode("logs", fresh));
  for (const gzip of [false, true]) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", ...(gzip ? { "content-encoding": "gzip" } : {}) },
      body: gzip ? Bun.gzipSync(body) : body,
    });
    expect(res.status).toBe(200);
  }
  const live = await (await fetch(`http://127.0.0.1:${PORT}/api/live`)).json();
  expect(live).toHaveLength(2);
  expect(live[0]).toMatchObject({ kind: "tool", ms: 812 });
});
