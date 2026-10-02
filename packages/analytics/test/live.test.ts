import { expect, test } from "bun:test";
import { liveEvent } from "../src";

test("liveEvent maps watched events and drops startup noise", () => {
  const ev = (name: string, attrs: Record<string, unknown>) => ({ tsMs: 1, name, sessionId: "s", promptId: null, attrs });
  expect(liveEvent(ev("hook_execution_complete", { hook_name: "Stop", total_duration_ms: 250 }))).toMatchObject({ kind: "hook", label: "Stop", ms: 250, ok: true });
  expect(liveEvent(ev("tool_result", { tool_name: "Bash", duration_ms: 9, success: "false" }))).toMatchObject({ kind: "tool", ok: false });
  expect(liveEvent(ev("hook_registered", {}))).toBeNull();
  expect(liveEvent(ev("plugin_loaded", {}))).toBeNull();
});
