import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { liveEvent } from "../src/analytics";

const s = (v: string) => ({ stringValue: v });
const PORT = 14000 + Math.floor(Math.random() * 1000);
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), CC_TELEMETRY_DIR: mkdtempSync(`${tmpdir()}/cc-live-`), NODE_ENV: "production" },
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

test("liveEvent maps watched events and drops startup noise", () => {
  const ev = (name: string, attrs: Record<string, unknown>) => ({ tsMs: 1, name, sessionId: "s", promptId: null, attrs });
  expect(liveEvent(ev("hook_execution_complete", { hook_name: "Stop", total_duration_ms: 250 }))).toMatchObject({ kind: "hook", label: "Stop", ms: 250, ok: true });
  expect(liveEvent(ev("tool_result", { tool_name: "Bash", duration_ms: 9, success: "false" }))).toMatchObject({ kind: "tool", ok: false });
  expect(liveEvent(ev("hook_registered", {}))).toBeNull();
  expect(liveEvent(ev("plugin_loaded", {}))).toBeNull();
});

test("ingested logs are pushed to WebSocket clients and kept in the live backlog", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);

  const msg = await Promise.race([received, Bun.sleep(2000).then(() => null)]);
  ws.close();
  expect(msg).not.toBeNull();
  expect(msg.type).toBe("events");
  expect(msg.events).toEqual([expect.objectContaining({ kind: "hook", label: "PreToolUse:Bash", ms: 1234, sessionId: "live-1" })]);

  const backlog = await (await fetch(`http://127.0.0.1:${PORT}/api/live`)).json();
  expect(backlog[0]).toMatchObject({ kind: "hook", label: "PreToolUse:Bash" });
});
