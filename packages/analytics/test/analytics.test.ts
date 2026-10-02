import { expect, test } from "bun:test";
import { parseLogs, parseTraces } from "@cpa/otlp";
import { percentile, status, summarize, toolLabel } from "../src";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function logRecord(name: string, msAgo: number, attrs: Record<string, any>) {
  return {
    timeUnixNano: String((NOW - msAgo) * 1e6),
    body: s(`claude_code.${name}`),
    attributes: [
      { key: "event.name", value: s(name) },
      { key: "session.id", value: s("sess-1") },
      { key: "prompt.id", value: s("p-1") },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value })),
    ],
  };
}

const payload = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: s("claude-code") }] },
      scopeLogs: [
        {
          logRecords: [
            logRecord("user_prompt", 9000, { prompt_length: i(12) }),
            logRecord("hook_execution_complete", 8800, { hook_name: s("UserPromptSubmit"), total_duration_ms: i(1200), num_hooks: i(2), num_blocking: i(0) }),
            logRecord("api_request", 6000, { model: s("claude-sonnet-5"), duration_ms: i(2500), cost_usd: { doubleValue: 0.02 }, input_tokens: i(100), cache_read_tokens: i(900), output_tokens: i(50) }),
            logRecord("hook_execution_complete", 5800, { hook_name: s("PreToolUse:Bash"), total_duration_ms: i(3000), num_hooks: i(1), num_non_blocking_error: i(1) }),
            logRecord("tool_result", 2000, { tool_name: s("Bash"), duration_ms: i(800), success: s("true") }),
            logRecord("tool_result", 1500, { tool_name: s("Skill"), duration_ms: i(40), success: s("false"), tool_parameters: s('{"skill_name":"dataviz"}') }),
            logRecord("api_request", 1000, { model: s("claude-sonnet-5"), duration_ms: i(1500), cost_usd: { doubleValue: 0.01 } }),
            logRecord("tool_decision", 1900, { tool_name: s("Bash"), decision: s("accept"), source: s("config") }),
            // outside a 1h window, must be ignored
            logRecord("api_request", 2 * 3600_000, { model: s("old"), duration_ms: i(99999) }),
          ],
        },
      ],
    },
  ],
};

test("parseLogs flattens OTLP JSON and strips the claude_code prefix", () => {
  const rows = parseLogs(payload);
  expect(rows).toHaveLength(9);
  const api = rows.find((r) => r.name === "api_request")!;
  expect(api.sessionId).toBe("sess-1");
  expect(api.promptId).toBe("p-1");
  expect(api.attrs.duration_ms).toBe(2500);
  expect(api.attrs["service.name"]).toBe("claude-code");
  expect(api.tsMs).toBe(NOW - 6000);
});

test("parseLogs prefers event.timestamp over a missing timeUnixNano", () => {
  const rows = parseLogs({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "0", attributes: [{ key: "event.timestamp", value: s("2026-10-02T11:59:00.000Z") }, { key: "event.name", value: s("compaction") }] }] }] }],
  });
  expect(rows[0]!.tsMs).toBe(NOW - 60_000);
  expect(rows[0]!.name).toBe("compaction");
});

test("summarize ranks hooks and tools by total time and splits turn time", () => {
  const out = summarize(parseLogs(payload), [], 3600_000, NOW);
  expect(out.kpis.apiRequests).toBe(2);
  expect(out.kpis.apiP50).toBe(1500);
  expect(out.kpis.apiP95).toBe(2500);
  expect(out.kpis.costUsd).toBeCloseTo(0.03);
  expect(out.kpis.cacheHitRatio).toBeCloseTo(0.9);
  expect(out.hooks.map((h) => h.name)).toEqual(["PreToolUse:Bash", "UserPromptSubmit"]);
  expect(out.hooks[0]!.failures).toBe(1);
  expect(out.tools.map((t) => t.name)).toEqual(["Bash", "Skill: dataviz"]);
  expect(out.breakdown).toEqual({ api: 4000, tools: 840, hooks: 4200 });
  expect(out.kpis.hookShare).toBeCloseTo(4200 / 9040);
  expect(out.permissions).toEqual([["config / accept", 1]]);
  expect(out.recentPrompts[0]!.wallMs).toBe(8000);
  expect(out.models.map((m) => m.name)).toEqual(["claude-sonnet-5"]);
});

test("status flags slow hooks for the menu bar", () => {
  const st = status(summarize(parseLogs(payload), [], 15 * 60_000, NOW));
  expect(st.state).toBe("slow");
  expect(st.label).toBe("1.5s");
  expect(st.tooltip).toContain("PreToolUse:Bash");
  expect(status(summarize([], [], 15 * 60_000, NOW)).state).toBe("idle");
});

test("ttft and turn time come from trace spans when present", () => {
  const span = (name: string, startAgo: number, dur: number, attrs: any[] = []) => ({
    traceId: "t",
    spanId: name,
    name,
    startTimeUnixNano: String((NOW - startAgo) * 1e6),
    endTimeUnixNano: String((NOW - startAgo + dur) * 1e6),
    attributes: attrs,
  });
  const spans = parseTraces({
    resourceSpans: [{ scopeSpans: [{ spans: [span("claude_code.interaction", 5000, 4200), span("claude_code.llm_request", 5000, 2000, [{ key: "ttft_ms", value: i(640) }])] }] }],
  });
  const out = summarize([], spans, 3600_000, NOW);
  expect(out.kpis.ttftP50).toBe(640);
  expect(out.kpis.turnP50).toBe(4200);
});

test("helpers", () => {
  expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  expect(percentile([], 95)).toBe(0);
  expect(toolLabel({ tool_name: "mcp_tool", tool_parameters: '{"mcp_server_name":"outline","mcp_tool_name":"fetch"}' })).toBe("mcp: outline/fetch");
});

test("turnTimeline places each span at timestamp minus duration", async () => {
  const { turnTimeline } = await import("../src");
  const t = turnTimeline(parseLogs(payload).filter((e) => e.tsMs > NOW - 3600_000))!;
  expect(t.promptId).toBe("p-1");
  expect(t.startMs).toBe(NOW - 10000);
  expect(t.endMs).toBe(NOW - 1000);
  const hook = t.spans.find((s) => s.label === "PreToolUse:Bash")!;
  expect([hook.startMs, hook.endMs, hook.ok]).toEqual([NOW - 8800, NOW - 5800, false]);
  expect(t.spans.map((s) => s.kind)).toEqual(["hook", "hook", "api", "tool", "api", "tool"]);
  expect(turnTimeline([])).toBeNull();
});
