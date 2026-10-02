import type { LatencyStats, PromptBreakdown, Summary, TurnSpan, TurnTimeline } from "../analytics";
import { fmtMs } from "../analytics";
import { startLive } from "./live";
import { startSetup } from "./setup";

import * as echarts from "echarts/core";
import { BarChart, CustomChart, LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, SVGRenderer]);

const app = document.getElementById("app")!;
const tip = document.getElementById("tip")!;
const updated = document.getElementById("updated")!;
const nav = document.getElementById("window")!;

let minutes = Number(safeGet("window") ?? 60);

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const byId = (id: string) => document.getElementById(id)!;

// Tooltip for non-chart elements (KPI tiles). Charts use echarts' own tooltip.
document.addEventListener("mousemove", (ev) => {
  const el = (ev.target as Element).closest?.("[data-tip]");
  if (!el) return void (tip.style.display = "none");
  showTip(el.getAttribute("data-tip")!, ev.clientX, ev.clientY);
});
function showTip(text: string, x: number, y: number) {
  tip.textContent = text;
  tip.style.display = "block";
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(x + 12, window.innerWidth - w - 8)}px`;
  tip.style.top = `${y + 14}px`;
}

function kpi(label: string, value: string, sub = "", flag = false, tipText = "") {
  return `<div class="kpi${flag ? " flag" : ""}"${tipText ? ` data-tip="${esc(tipText)}"` : ""}>
    <div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function legend(items: [string, string][]) {
  return `<div class="legend">${items.map(([c, l]) => `<span><i style="background:var(${c})"></i>${esc(l)}</span>`).join("")}</div>`;
}

// [css var, palette key, label] for the three turn-time components, shared by the breakdown
// bar, the waterfall legend and the recent-prompts chart.
const PARTS: [string, keyof Palette, string][] = [
  ["--api", "api", "Model (API)"],
  ["--tools", "tools", "Tools"],
  ["--hooks", "hooks", "Hooks"],
];

interface Palette {
  api: string;
  apiSoft: string;
  tools: string;
  hooks: string;
  critical: string;
  muted: string;
  ink: string;
  ink2: string;
  grid: string;
  axis: string;
  surface: string;
  border: string;
}

// Read live CSS custom properties so charts follow light/dark mode without a reload.
function palette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    api: v("--api"),
    apiSoft: v("--api-soft"),
    tools: v("--tools"),
    hooks: v("--hooks"),
    critical: v("--critical"),
    muted: v("--muted"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    grid: v("--grid"),
    axis: v("--axis"),
    surface: v("--surface"),
    border: v("--border"),
  };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
type Option = Record<string, any>;

// One echarts instance per container, reused across refreshes via setOption instead of
// dispose+recreate (keeps dataZoom/legend selection state and avoids 500ms-cadence churn).
const charts = new Map<string, echarts.EChartsType>();
function chartFor(id: string, onInit?: (c: echarts.EChartsType) => void): echarts.EChartsType {
  let c = charts.get(id);
  if (!c || c.isDisposed()) {
    const el = byId(id);
    el.innerHTML = "";
    c = echarts.init(el, null, { renderer: "svg" });
    charts.set(id, c);
    onInit?.(c);
  }
  return c;
}
function clearChart(id: string, emptyHtml: string) {
  const c = charts.get(id);
  if (c && !c.isDisposed()) c.dispose();
  charts.delete(id);
  byId(id).innerHTML = emptyHtml;
}
function disposeCharts() {
  for (const c of charts.values()) if (!c.isDisposed()) c.dispose();
  charts.clear();
}

function statTip(r: LatencyStats, extraLines: string[] = []) {
  return [r.name, `${r.count} runs, total ${fmtMs(r.totalMs)}`, `p50 ${fmtMs(r.p50)}  p95 ${fmtMs(r.p95)}  max ${fmtMs(r.maxMs)}`, ...extraLines]
    .concat(r.failures ? [`${r.failures} failed`] : [])
    .join("\n");
}

// Hook/tool/model names and prompt commands come from telemetry and are untrusted. Tooltip
// formatters return HTML, so every line goes through esc() before joining with <br/>.
function tooltipHtml(text: string): string {
  return text.split("\n").map(esc).join("<br/>");
}

function table(headers: string[], rows: (string | number)[][], numericFrom = 1) {
  if (!rows.length) return `<p class="empty">No data in this window.</p>`;
  const th = headers.map((h, i) => `<th class="${i >= numericFrom ? "num" : ""}">${esc(h)}</th>`).join("");
  const tr = rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${i >= numericFrom ? "num" : "name"}" title="${esc(c)}">${esc(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><tr>${th}</tr>${tr}</table>`;
}

function setupHelp() {
  return `<div class="card"><h2>No telemetry yet</h2>
  <p>Use the button above, or start Claude Code with these variables:</p>
  <pre>CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_LOGS_EXPORT_INTERVAL=1000
OTEL_LOG_TOOL_DETAILS=1
# optional, beta: time-to-first-token and turn spans
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
OTEL_TRACES_EXPORTER=otlp</pre></div>`;
}

// ---- chart option builders ----

function breakdownOption(pal: Palette, b: Summary["breakdown"]): Option {
  const vals = [b.api, b.tools, b.hooks];
  const total = vals.reduce((a, v) => a + v, 0) || 1;
  const pcts = vals.map((v) => (v / total) * 100);
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: 2, right: 2, top: 2, bottom: 2 },
    xAxis: { type: "value", max: 100, show: false },
    yAxis: { type: "category", data: [""], show: false },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => tooltipHtml(`${PARTS[p.seriesIndex as number]![2]}: ${fmtMs(vals[p.seriesIndex as number]!)} (${pct(vals[p.seriesIndex as number]! / total)})`),
    },
    series: PARTS.map(([, colorKey, name], i) => ({
      name,
      type: "bar",
      stack: "total",
      barWidth: "68%",
      data: [pcts[i]],
      itemStyle: { color: pal[colorKey] },
      label: {
        show: pcts[i]! > 8,
        formatter: `${name} ${pcts[i]!.toFixed(0)}%`,
        color: "#ffffff",
        fontWeight: 600,
        textBorderWidth: 0,
        fontSize: 11,
        fontFamily: FONT,
      },
    })),
  };
}

function latencyOption(pal: Palette, pts: Summary["apiSeries"]["points"]): Option {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    legend: {
      data: ["p50", "p95"],
      top: 0,
      right: 4,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: pal.ink2, fontSize: 11, fontFamily: FONT },
    },
    grid: { left: 44, right: 10, top: 28, bottom: 26 },
    xAxis: {
      type: "time",
      axisLabel: { color: pal.muted, fontSize: 11, fontFamily: FONT, formatter: (v: number) => clock(v) },
      axisLine: { lineStyle: { color: pal.axis } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: pal.muted, fontSize: 11, fontFamily: FONT, formatter: (v: number) => fmtMs(v) },
      splitLine: { lineStyle: { color: pal.grid } },
      axisLine: { show: false },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: pal.surface,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (params: any[]) => {
        if (!params.length) return "";
        const t = Number(params[0].value[0]);
        const byName: Record<string, number | null> = {};
        for (const p of params) byName[p.seriesName as string] = p.value[1];
        const bucket = pts.find((pt) => pt.t === t);
        const lines = [clock(t)];
        if (bucket?.count) lines.push(`p50 ${fmtMs(byName.p50 ?? 0)}`, `p95 ${fmtMs(byName.p95 ?? 0)}`, `${bucket.count} requests`);
        else lines.push("no requests");
        return tooltipHtml(lines.join("\n"));
      },
    },
    // "inside" dataZoom only: scroll to zoom, drag to pan.
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [
      {
        name: "p50",
        type: "line",
        data: pts.map((p) => [p.t, p.p50]),
        // Small symbols so an isolated bucket (no line to connect to) still shows as a point.
        symbol: "circle",
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { color: pal.api, width: 2 },
        itemStyle: { color: pal.api },
      },
      {
        name: "p95",
        type: "line",
        data: pts.map((p) => [p.t, p.p95]),
        symbol: "circle",
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { color: pal.apiSoft, width: 2, type: "dashed" },
        itemStyle: { color: pal.apiSoft },
      },
    ],
  };
}

function leftMarginFor(names: string[]): number {
  const longest = Math.min(30, names.reduce((m, n) => Math.max(m, n.length), 1));
  return Math.min(190, Math.max(60, longest * 6 + 16));
}

// Shared layout for "Hooks by total time" and "Tools, skills, MCP by total time":
// horizontal bars sorted by total (callers pass already-sorted rows), value label at bar end.
function statBarOption(pal: Palette, rows: LatencyStats[], colorKey: "hooks" | "tools", extraTip: (r: LatencyStats) => string[]): Option {
  const names = rows.map((r) => r.name);
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: leftMarginFor(names), right: 64, top: 2, bottom: 2 },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: names,
      inverse: true,
      axisLabel: { color: pal.ink2, fontSize: 11, fontFamily: FONT, formatter: (v: string) => (v.length > 30 ? `${v.slice(0, 29)}…` : v) },
      axisLine: { lineStyle: { color: pal.axis } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => tooltipHtml(p.data.tipText as string),
    },
    series: [
      {
        type: "bar",
        barWidth: "62%",
        itemStyle: { color: pal[colorKey], borderRadius: 3 },
        data: rows.map((r) => ({
          value: r.totalMs,
          tipText: statTip(r, extraTip(r)),
          labelNote: `${fmtMs(r.totalMs)} · ${r.count}×`,
        })),
        label: {
          show: true,
          position: "right",
          color: pal.ink2,
          fontSize: 11,
          fontFamily: FONT,
          formatter: (p: any) => p.data.labelNote as string,
        },
      },
    ],
  };
}

function promptsOption(pal: Palette, prompts: PromptBreakdown[]): Option {
  const names = prompts.map((p) => `${clock(p.startMs)} ${p.command ?? ""}`.trim());
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: leftMarginFor(names), right: 56, top: 2, bottom: 2 },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: names,
      inverse: true,
      axisLabel: { color: pal.ink2, fontSize: 11, fontFamily: FONT, formatter: (v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v) },
      axisLine: { lineStyle: { color: pal.axis } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => tooltipHtml(p.data.tipText as string),
    },
    series: PARTS.map(([, colorKey, label], seriesIdx) => ({
      name: label,
      type: "bar",
      stack: "total",
      barWidth: "60%",
      itemStyle: { color: pal[colorKey] },
      data: prompts.map((p, i) => {
        const vals = [p.apiMs, p.toolMs, p.hookMs];
        const sum = vals.reduce((a, v) => a + v, 0);
        return {
          value: vals[seriesIdx],
          sum,
          tipText: `${names[i]}\n${label}: ${fmtMs(vals[seriesIdx]!)}\nAPI calls ${p.apiCalls}, tool calls ${p.toolCalls}\nWall clock ~${fmtMs(p.wallMs)}, cost ${usd(p.costUsd)}`,
        };
      }),
      // Only the last stacked series sits at the bar's far end, so the running total goes there.
      label:
        seriesIdx === PARTS.length - 1
          ? { show: true, position: "right", color: pal.ink2, fontSize: 11, fontFamily: FONT, formatter: (p: any) => fmtMs(p.data.sum as number) }
          : undefined,
    })),
  };
}

// Agent and compaction spans share the muted color; the legend groups them as one entry.
function kindColor(pal: Palette, kind: TurnSpan["kind"]): string {
  if (kind === "api") return pal.api;
  if (kind === "tool") return pal.tools;
  if (kind === "hook") return pal.hooks;
  return pal.muted;
}

const WF_ROW_H = 22;
const WF_MAX_ROWS = 40;

function waterfallOption(pal: Palette, turn: TurnTimeline): Option {
  const rows = turn.spans.map((sp) => ({ ...sp, startOffset: sp.startMs - turn.startMs, endOffset: sp.endMs - turn.startMs }));
  const categories = rows.map((r) => {
    const label = r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label;
    return `+${fmtMs(r.startOffset)}  ${label}`;
  });
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: leftMarginFor(categories), right: 20, top: 8, bottom: 26 },
    xAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: pal.muted, fontSize: 11, fontFamily: FONT, formatter: (v: number) => fmtMs(v) },
      splitLine: { lineStyle: { color: pal.grid } },
      axisLine: { lineStyle: { color: pal.axis } },
    },
    yAxis: {
      type: "category",
      data: categories,
      inverse: true,
      // Show every row label; echarts hides some by default when rows are tight.
      axisLabel: { color: pal.ink2, fontSize: 11, fontFamily: FONT, interval: 0 },
      axisLine: { lineStyle: { color: pal.axis } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => {
        const r = rows[p.dataIndex as number]!;
        const lines = [r.label, r.kind, `start +${fmtMs(r.startOffset)}`, `duration ${fmtMs(r.endOffset - r.startOffset)}`];
        if (!r.ok) lines.push("failed");
        return tooltipHtml(lines.join("\n"));
      },
    },
    series: [
      {
        type: "custom",
        encode: { x: [1, 2], y: 0 },
        // Standard echarts Gantt pattern: position a rect in pixel space via api.coord/api.size.
        renderItem: (params: any, api: any) => {
          const categoryIndex = api.value(0);
          const start = api.coord([api.value(1), categoryIndex]);
          const end = api.coord([api.value(2), categoryIndex]);
          const height = (api.size([0, 1]) as number[])[1]! * 0.6;
          const shape = (echarts as any).graphic.clipRectByRect(
            { x: start[0], y: start[1] - height / 2, width: Math.max(1, end[0] - start[0]), height },
            { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
          );
          return shape && { type: "rect", shape, style: api.style() };
        },
        data: rows.map((r, i) => ({
          value: [i, r.startOffset, r.endOffset],
          itemStyle: { color: kindColor(pal, r.kind), borderColor: r.ok ? "transparent" : pal.critical, borderWidth: r.ok ? 0 : 1.5 },
        })),
      },
    ],
  };
}

function waterfallTitle(turn: TurnTimeline): string {
  const parts = [clock(turn.startMs)];
  if (turn.command) parts.push(turn.command);
  parts.push(`${fmtMs(turn.endMs - turn.startMs)} total`);
  return parts.join(" · ");
}

// ---- DOM update functions (chart instances persist; only data/text change) ----

function updateKpis(s: Summary) {
  const k = s.kpis;
  const slowHook = s.hooks.find((h) => h.p95 > 2000);
  byId("kpi-row").innerHTML = [
    kpi("API latency p50", fmtMs(k.apiP50), `p95 ${fmtMs(k.apiP95)} · ${k.apiRequests} req`),
    kpi(
      "Turn time p50",
      fmtMs(k.turnP50),
      `${k.prompts} prompts · ${k.sessions} sessions`,
      false,
      "From interaction spans when traces are on, else first-to-last event per prompt",
    ),
    kpi("Time to first token", k.ttftP50 === null ? "n/a" : fmtMs(k.ttftP50), k.ttftP50 === null ? "needs traces (beta)" : "p50"),
    kpi(
      "Hook time",
      fmtMs(k.hookTotalMs),
      `${pct(k.hookShare)} of in-turn time`,
      k.hookShare > 0.15 || !!slowHook,
      slowHook ? `Slowest: ${slowHook.name}, p95 ${fmtMs(slowHook.p95)}` : "",
    ),
    kpi("Cost", usd(k.costUsd), `${compact(k.tokens.output)} out · ${compact(k.tokens.input)} in`),
    kpi("Cache hit", pct(k.cacheHitRatio), `${compact(k.tokens.cacheRead)} read · ${compact(k.tokens.cacheCreation)} write`),
  ].join("");
}

function updateTables(s: Summary) {
  byId("t-skills").innerHTML = table(
    ["Skill", "Activations", "API calls", "API time", "Cost"],
    s.skills.map((r) => [r.name, r.extra?.activations ?? 0, r.count, fmtMs(r.totalMs), usd(Number(r.extra?.costUsd ?? 0))]),
  );
  byId("t-subagents").innerHTML = table(
    ["Agent", "Runs", "p50", "Total", "Tool uses"],
    s.subagents.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.totalMs), r.extra?.toolUses ?? 0]),
  );
  byId("t-models").innerHTML = table(
    ["Model", "Requests", "p50", "p95", "Total"],
    s.models.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.p95), fmtMs(r.totalMs)]),
  );
  byId("t-permissions").innerHTML = table(["Source / decision", "Count"], s.permissions);
  byId("t-mcp").innerHTML = table(
    ["Server", "Connects", "p50", "Max", "Failed"],
    s.mcpConnections.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.maxMs), r.failures]),
  );
  byId("t-errors").innerHTML = table("Kind Count".split(" "), [
    ...s.errors,
    ...(s.kpis.compactions ? [[`Compactions (${fmtMs(s.kpis.compactionMs)})`, s.kpis.compactions] as [string, number]] : []),
  ]);
}

function updateBreakdownChart(pal: Palette, s: Summary) {
  const c = chartFor("c-breakdown");
  c.resize();
  c.setOption(breakdownOption(pal, s.breakdown));
}

function updateLatencyChart(pal: Palette, s: Summary) {
  const pts = s.apiSeries.points;
  if (!pts.some((p) => p.count)) return void clearChart("c-latency", `<p class="empty">No API requests in this window.</p>`);
  const c = chartFor("c-latency");
  c.resize();
  // Merge (default notMerge:false): keeps the user's dataZoom selection across refreshes.
  c.setOption(latencyOption(pal, pts));
}

function updateHooksChart(pal: Palette, s: Summary) {
  const rows = s.hooks.slice(0, 12);
  if (!rows.length) return void clearChart("c-hooks", `<p class="empty">No data in this window.</p>`);
  byId("c-hooks").style.height = `${rows.length * 22}px`;
  const c = chartFor("c-hooks");
  c.resize();
  // notMerge: the row set (and its order) changes between refreshes.
  c.setOption(
    statBarOption(pal, rows, "hooks", (r) => [`blocking ${r.extra?.blocking ?? 0}, injected context ${compact(Number(r.extra?.contextChars ?? 0))} chars`]),
    true,
  );
}

function updateToolsChart(pal: Palette, s: Summary) {
  const rows = s.tools.slice(0, 12);
  if (!rows.length) return void clearChart("c-tools", `<p class="empty">No data in this window.</p>`);
  byId("c-tools").style.height = `${rows.length * 22}px`;
  const c = chartFor("c-tools");
  c.resize();
  c.setOption(statBarOption(pal, rows, "tools", () => []), true);
}

let recentPromptsList: PromptBreakdown[] = [];

function updatePromptsChart(pal: Palette, s: Summary) {
  const prompts = s.recentPrompts;
  recentPromptsList = prompts;
  if (!prompts.length) return void clearChart("c-prompts", `<p class="empty">No prompts in this window.</p>`);
  byId("c-prompts").style.height = `${prompts.length * 22}px`;
  const c = chartFor("c-prompts", (inst) => {
    inst.on("click", (params: any) => {
      if (params.componentType !== "series") return;
      const p = recentPromptsList[params.dataIndex as number];
      if (p) selectPrompt(p.promptId);
    });
  });
  c.resize();
  c.setOption(promptsOption(pal, prompts), true);
}

function renderWaterfall(turn: TurnTimeline | null) {
  const titleEl = byId("wf-title");
  if (!turn || !turn.spans.length) {
    clearChart("c-waterfall", `<p class="empty">No data for this prompt.</p>`);
    titleEl.textContent = turn ? "No spans recorded." : "No recent prompt.";
    return;
  }
  titleEl.textContent = waterfallTitle(turn);
  // Plus room for the x axis and grid padding.
  byId("c-waterfall").style.height = `${Math.max(1, turn.spans.length) * WF_ROW_H + 40}px`;
  const c = chartFor("c-waterfall");
  c.resize();
  // notMerge: span count changes per prompt.
  c.setOption(waterfallOption(palette(), turn), true);
}

// ---- page skeleton and render ----

let skeletonReady = false;

function skeletonHtml(): string {
  return `
    <section class="kpis" id="kpi-row"></section>
    <div class="card"><h2>Where turn time goes</h2>
      ${legend(PARTS.map(([c, , l]) => [c, l] as [string, string]))}
      <div id="c-breakdown"></div>
      <p class="muted" style="margin:4px 0 0;font-size:11px">Summed component time. Parallel tool calls can overlap, so parts may exceed wall clock.</p>
    </div>
    <div class="card"><h2>Turn waterfall</h2>
      <div class="muted" id="wf-title" style="font-size:11px;margin-bottom:6px"></div>
      ${legend([["--api", "Model (API)"], ["--tools", "Tools"], ["--hooks", "Hooks"], ["--muted", "Agent / compaction"]])}
      <div class="wf-scroll"><div id="c-waterfall"></div></div>
    </div>
    <div class="card"><h2>API latency over time</h2><div id="c-latency"></div></div>
    <div class="grid2">
      <div class="card"><h2>Hooks by total time</h2><div id="c-hooks"></div></div>
      <div class="card"><h2>Tools, skills, MCP by total time</h2><div id="c-tools"></div></div>
    </div>
    <div class="card"><h2>Recent prompts</h2>
      ${legend(PARTS.map(([c, , l]) => [c, l] as [string, string]))}
      <div id="c-prompts"></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Skills</h2><div id="t-skills"></div></div>
      <div class="card"><h2>Subagents</h2><div id="t-subagents"></div></div>
      <div class="card"><h2>Models</h2><div id="t-models"></div></div>
      <div class="card"><h2>Permission decisions (rules = config)</h2><div id="t-permissions"></div></div>
      <div class="card"><h2>MCP server connect</h2><div id="t-mcp"></div></div>
      <div class="card"><h2>Errors and compaction</h2><div id="t-errors"></div></div>
    </div>`;
}

function render(s: Summary) {
  if (s.eventCount === 0) {
    disposeCharts();
    app.innerHTML = setupHelp();
    skeletonReady = false;
    return;
  }
  if (!skeletonReady) {
    app.innerHTML = skeletonHtml();
    skeletonReady = true;
  }
  updateKpis(s);
  updateTables(s);
  const pal = palette();
  updateBreakdownChart(pal, s);
  updateLatencyChart(pal, s);
  updateHooksChart(pal, s);
  updateToolsChart(pal, s);
  updatePromptsChart(pal, s);
}

let last: Summary | null = null;
let selectedPromptId: string | null = null;

async function load() {
  try {
    const res = await fetch(`/api/summary?minutes=${minutes}`);
    last = (await res.json()) as Summary;
    render(last);
    updated.textContent = `${last.eventCount} events · ${clock(last.generatedAt)}`;
    if (!selectedPromptId && skeletonReady) loadTurn();
  } catch (err) {
    disposeCharts();
    skeletonReady = false;
    app.innerHTML = `<div class="card"><h2>Collector unreachable</h2><p class="muted">${esc(err)}</p></div>`;
  }
}

async function loadTurn(promptId?: string) {
  try {
    const url = promptId ? `/api/turn?prompt=${encodeURIComponent(promptId)}` : "/api/turn";
    const res = await fetch(url);
    const turn = (await res.json()) as TurnTimeline | null;
    renderWaterfall(turn);
  } catch {}
}

function selectPrompt(promptId: string) {
  selectedPromptId = promptId;
  loadTurn(promptId);
}

function markNav() {
  nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.min) === minutes));
}
nav.addEventListener("click", (ev) => {
  const b = (ev.target as Element).closest("button");
  if (!b) return;
  minutes = Number(b.dataset.min);
  safeSet("window", String(minutes));
  markNav();
  load();
});
window.addEventListener("resize", () => {
  for (const c of charts.values()) if (!c.isDisposed()) c.resize();
});

// Pushed events trigger a refresh; batch bursts so the summary query runs at most twice a second.
let pending: ReturnType<typeof setTimeout> | null = null;
function loadSoon() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    load();
  }, 500);
}

markNav();
load();
startLive(document.getElementById("live")!, loadSoon);
startSetup(document.getElementById("setup")!);
// Fallback for when the socket is down, and to roll the time window forward.
setInterval(load, 30_000);
