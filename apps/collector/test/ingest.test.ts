import { afterAll, beforeAll, expect, test } from "bun:test";
import { requestType } from "@cpa/otlp";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
let collector: Awaited<ReturnType<typeof startCollector>>;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(() => collector.stop());

test("accepts http/protobuf, plain and gzipped", async () => {
  // /api/live only covers the last hour, so stamp the record with the current time.
  const logs = {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: s("claude-code") }] },
      scopeLogs: [{ logRecords: [{
        timeUnixNano: `${Date.now()}000000`,
        body: s("claude_code.tool_result"),
        attributes: [
          { key: "event.name", value: s("tool_result") },
          { key: "session.id", value: s("pb-1") },
          { key: "prompt.id", value: s("p-9") },
          { key: "duration_ms", value: { intValue: "812" } },
        ],
      }] }],
    }],
  };
  const t = requestType("logs");
  const body = new Uint8Array(t.encode(t.fromObject(logs)).finish());
  for (const gzip of [false, true]) {
    const res = await fetch(`${collector.url}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", ...(gzip ? { "content-encoding": "gzip" } : {}) },
      body: gzip ? Bun.gzipSync(body) : body,
    });
    expect(res.status).toBe(200);
  }
  // Runs first on a fresh store, so the backlog holds only these two records.
  const live = await (await fetch(`${collector.url}/api/live`)).json();
  expect(live).toHaveLength(2);
  expect(live[0]).toMatchObject({ kind: "tool", ms: 812, sessionId: "pb-1" });
});

test("ingested logs are pushed to WebSocket clients and kept in the live backlog", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${collector.port}/ws`);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const received = new Promise<any>((resolve) => (ws.onmessage = (m) => resolve(JSON.parse(String(m.data)))));

  const body = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      { timeUnixNano: String(Date.now() * 1e6), attributes: [
        { key: "event.name", value: s("hook_execution_complete") },
        { key: "session.id", value: s("live-1") },
        { key: "hook_name", value: s("PreToolUse:Bash") },
        { key: "total_duration_ms", value: { intValue: "1234" } },
      ] },
    ] }] }],
  };
  const res = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);

  const msg = await Promise.race([received, Bun.sleep(2000).then(() => null)]);
  ws.close();
  expect(msg).not.toBeNull();
  expect(msg.type).toBe("events");
  expect(msg.events).toEqual([expect.objectContaining({ kind: "hook", label: "PreToolUse:Bash", ms: 1234, sessionId: "live-1" })]);

  const backlog = await (await fetch(`${collector.url}/api/live`)).json();
  expect(backlog[0]).toMatchObject({ kind: "hook", label: "PreToolUse:Bash" });
});
