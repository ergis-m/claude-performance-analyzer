// Turns raw telemetry rows into the dashboard summary.
import type { Attrs, EventRow, SpanRow } from "./otlp";

export interface LatencyStats {
  name: string;
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
  maxMs: number;
  failures: number;
  extra?: Record<string, number | string>;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isFalse(v: unknown): boolean {
  return v === false || v === "false";
}

function parseJson(v: unknown): Attrs {
  if (typeof v !== "string") return typeof v === "object" && v ? (v as Attrs) : {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

class Group {
  durations: number[] = [];
  failures = 0;
  extra: Record<string, number> = {};
  add(ms: number, failed = false) {
    this.durations.push(ms);
    if (failed) this.failures++;
  }
  bump(key: string, by = 1) {
    this.extra[key] = (this.extra[key] ?? 0) + by;
  }
  stats(name: string): LatencyStats {
    const sorted = [...this.durations].sort((a, b) => a - b);
    return {
      name,
      count: sorted.length,
      totalMs: sorted.reduce((a, b) => a + b, 0),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      maxMs: sorted.at(-1) ?? 0,
      failures: this.failures,
      extra: this.extra,
    };
  }
}

class Groups {
  map = new Map<string, Group>();
  get(key: string): Group {
    let g = this.map.get(key);
    if (!g) this.map.set(key, (g = new Group()));
    return g;
  }
  list(): LatencyStats[] {
    return [...this.map].map(([k, g]) => g.stats(k)).sort((a, b) => b.totalMs - a.totalMs);
  }
}

// Tool name with the detail that makes it useful: which skill, MCP tool or subagent.
export function toolLabel(attrs: Attrs): string {
  const tool = String(attrs.tool_name ?? "unknown");
  const params = parseJson(attrs.tool_parameters);
  if (params.skill_name) return `${tool}: ${params.skill_name}`;
  if (params.subagent_type) return `${tool}: ${params.subagent_type}`;
  if (params.mcp_server_name) return `mcp: ${params.mcp_server_name}/${params.mcp_tool_name ?? "?"}`;
  return tool;
}

export interface PromptBreakdown {
  promptId: string;
  startMs: number;
  wallMs: number;
  apiMs: number;
  toolMs: number;
  hookMs: number;
  apiCalls: number;
  toolCalls: number;
  costUsd: number;
  command: string | null;
}

export function summarize(events: EventRow[], spans: SpanRow[], windowMs: number, nowMs = Date.now()) {
  const sinceMs = nowMs - windowMs;
  const bucketCount = 30;
  const bucketMs = Math.max(60_000, Math.ceil(windowMs / bucketCount / 60_000) * 60_000);
  const firstBucket = Math.floor(sinceMs / bucketMs) * bucketMs;

  const api = new Groups();
  const hooks = new Groups();
  const tools = new Groups();
  const skills = new Groups();
  const subagents = new Groups();
  const mcpConnect = new Groups();
  const apiBuckets = new Map<number, number[]>();
  const permissions: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const prompts = new Map<string, PromptBreakdown>();
  const sessions = new Set<string>();
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let costUsd = 0;
  let compactions = 0;
  let compactionMs = 0;

  const prompt = (e: EventRow): PromptBreakdown | null => {
    if (!e.promptId) return null;
    let p = prompts.get(e.promptId);
    if (!p) {
      p = { promptId: e.promptId, startMs: e.tsMs, wallMs: 0, apiMs: 0, toolMs: 0, hookMs: 0, apiCalls: 0, toolCalls: 0, costUsd: 0, command: null };
      prompts.set(e.promptId, p);
    }
    p.startMs = Math.min(p.startMs, e.tsMs);
    p.wallMs = Math.max(p.wallMs, e.tsMs - p.startMs);
    return p;
  };

  for (const e of events) {
    if (e.tsMs < sinceMs) continue;
    const a = e.attrs;
    if (e.sessionId) sessions.add(e.sessionId);
    const p = prompt(e);
    switch (e.name) {
      case "user_prompt":
        if (p && a.command_name) p.command = String(a.command_name);
        break;
      case "api_request": {
        const ms = num(a.duration_ms);
        api.get(String(a.model ?? "unknown")).add(ms);
        const b = Math.floor(e.tsMs / bucketMs) * bucketMs;
        (apiBuckets.get(b) ?? apiBuckets.set(b, []).get(b)!).push(ms);
        const cost = num(a.cost_usd);
        costUsd += cost;
        tokens.input += num(a.input_tokens);
        tokens.output += num(a.output_tokens);
        tokens.cacheRead += num(a.cache_read_tokens);
        tokens.cacheCreation += num(a.cache_creation_tokens);
        if (a["skill.name"]) {
          const g = skills.get(String(a["skill.name"]));
          g.add(ms);
          g.bump("costUsd", cost);
        }
        if (p) {
          p.apiMs += ms;
          p.apiCalls++;
          p.costUsd += cost;
        }
        break;
      }
      case "api_error":
        errors[`API ${a.status_code ?? "error"}`] = (errors[`API ${a.status_code ?? "error"}`] ?? 0) + 1;
        break;
      case "tool_result": {
        const ms = num(a.duration_ms);
        const failed = isFalse(a.success);
        tools.get(toolLabel(a)).add(ms, failed);
        if (p) {
          p.toolMs += ms;
          p.toolCalls++;
        }
        break;
      }
      case "tool_decision": {
        const key = `${a.source ?? "unknown"} / ${a.decision ?? "?"}`;
        permissions[key] = (permissions[key] ?? 0) + 1;
        break;
      }
      case "hook_execution_complete": {
        const ms = num(a.total_duration_ms);
        const failed = num(a.num_non_blocking_error) > 0;
        const g = hooks.get(String(a.hook_name ?? a.hook_event ?? "unknown"));
        g.add(ms, failed);
        g.bump("hooks", num(a.num_hooks));
        g.bump("blocking", num(a.num_blocking));
        g.bump("contextChars", num(a.additional_context_chars) + num(a.system_message_chars));
        if (p) p.hookMs += ms;
        break;
      }
      case "skill_activated":
        skills.get(String(a["skill.name"] ?? "unknown")).bump("activations");
        break;
      case "subagent_completed": {
        const g = subagents.get(String(a.agent_type ?? "unknown"));
        g.add(num(a.duration_ms));
        g.bump("toolUses", num(a.total_tool_uses));
        break;
      }
      case "mcp_server_connection":
        if (a.status !== "disconnected")
          mcpConnect.get(String(a.server_name ?? a.transport_type ?? "mcp")).add(num(a.duration_ms), a.status === "failed");
        break;
      case "compaction":
        compactions++;
        compactionMs += num(a.duration_ms);
        break;
    }
  }

  // Traces (beta) carry time-to-first-token, which events do not.
  const ttft: number[] = [];
  const turnMs: number[] = [];
  for (const s of spans) {
    if (s.startMs < sinceMs) continue;
    if (s.name === "claude_code.llm_request" && s.attrs.ttft_ms !== undefined) ttft.push(num(s.attrs.ttft_ms));
    if (s.name === "claude_code.interaction") turnMs.push(s.endMs - s.startMs);
  }
  ttft.sort((a, b) => a - b);
  turnMs.sort((a, b) => a - b);

  const promptList = [...prompts.values()].sort((a, b) => b.startMs - a.startMs);
  const apiAll = [...api.map.values()].flatMap((g) => g.durations).sort((a, b) => a - b);
  const totals = promptList.reduce(
    (t, p) => ({ api: t.api + p.apiMs, tools: t.tools + p.toolMs, hooks: t.hooks + p.hookMs }),
    { api: 0, tools: 0, hooks: 0 },
  );
  const hookList = hooks.list();
  const hookTotalMs = hookList.reduce((s, h) => s + h.totalMs, 0);

  const series: { t: number; p50: number | null; p95: number | null; count: number }[] = [];
  for (let t = firstBucket; t <= nowMs; t += bucketMs) {
    const vals = (apiBuckets.get(t) ?? []).sort((a, b) => a - b);
    series.push({ t, p50: vals.length ? percentile(vals, 50) : null, p95: vals.length ? percentile(vals, 95) : null, count: vals.length });
  }

  const totalInput = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return {
    windowMs,
    generatedAt: nowMs,
    eventCount: events.length,
    spanCount: spans.length,
    kpis: {
      sessions: sessions.size,
      prompts: promptList.length,
      apiRequests: apiAll.length,
      apiP50: percentile(apiAll, 50),
      apiP95: percentile(apiAll, 95),
      ttftP50: ttft.length ? percentile(ttft, 50) : null,
      turnP50: turnMs.length ? percentile(turnMs, 50) : percentile(promptList.map((p) => p.wallMs).sort((a, b) => a - b), 50),
      costUsd,
      tokens,
      cacheHitRatio: totalInput ? tokens.cacheRead / totalInput : 0,
      hookTotalMs,
      hookShare: totals.api + totals.tools + totals.hooks ? totals.hooks / (totals.api + totals.tools + totals.hooks) : 0,
      compactions,
      compactionMs,
    },
    breakdown: totals,
    apiSeries: { bucketMs, points: series },
    models: api.list(),
    hooks: hookList,
    tools: tools.list(),
    skills: skills.list(),
    subagents: subagents.list(),
    mcpConnections: mcpConnect.list(),
    permissions: Object.entries(permissions).sort((a, b) => b[1] - a[1]),
    errors: Object.entries(errors).sort((a, b) => b[1] - a[1]),
    recentPrompts: promptList.slice(0, 12),
  };
}

export type Summary = ReturnType<typeof summarize>;

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// Menu bar text: median API latency over the window, flagged when hooks eat real time.
export function status(s: Summary) {
  const k = s.kpis;
  if (k.apiRequests === 0) return { label: "idle", state: "idle", tooltip: "No Claude Code API requests in the last 15 min" };
  const slowHook = s.hooks.find((h) => h.p95 > 2000);
  const slow = k.hookShare > 0.15 || !!slowHook;
  const lines = [
    `API p50 ${fmtMs(k.apiP50)} / p95 ${fmtMs(k.apiP95)} (${k.apiRequests} req)`,
    `Hooks ${fmtMs(k.hookTotalMs)} total, ${(k.hookShare * 100).toFixed(0)}% of in-turn time`,
    `Cost $${k.costUsd.toFixed(2)}, cache hit ${(k.cacheHitRatio * 100).toFixed(0)}%`,
  ];
  if (slowHook) lines.push(`Slowest hook: ${slowHook.name} p95 ${fmtMs(slowHook.p95)}`);
  return { label: fmtMs(k.apiP50), state: slow ? "slow" : "ok", tooltip: lines.join("\n") };
}
