import type { LatencyStats, PromptBreakdown, Summary } from "../analytics";
import { fmtMs } from "../analytics";
import { startLive } from "./live";

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

// One tooltip for every chart: any element with data-tip shows it on hover.
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

// Horizontal bars, sorted by the caller. Label column left, value right.
function hbars(width: number, rows: { label: string; value: number; tip: string; color: string; note: string }[]) {
  if (!rows.length) return `<p class="empty">No data in this window.</p>`;
  const labelW = Math.min(190, width * 0.38);
  const valueW = 92;
  const rowH = 22;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const barMax = width - labelW - valueW;
  const body = rows
    .map((r, i) => {
      const y = i * rowH;
      const w = Math.max(2, (r.value / max) * barMax);
      const label = r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label;
      return `<g data-tip="${esc(r.tip)}">
        <rect x="0" y="${y}" width="${width}" height="${rowH}" fill="transparent"/>
        <text x="${labelW - 8}" y="${y + 15}" text-anchor="end" class="ink">${esc(label)}</text>
        <rect x="${labelW}" y="${y + 5}" width="${w}" height="12" rx="3" fill="var(${r.color})"/>
        <text x="${labelW + w + 6}" y="${y + 15}">${esc(r.note)}</text></g>`;
    })
    .join("");
  return `<svg width="${width}" height="${rows.length * rowH}" role="img">${body}</svg>`;
}

const PARTS: [keyof Pick<PromptBreakdown, "apiMs" | "toolMs" | "hookMs">, string, string][] = [
  ["apiMs", "--api", "Model (API)"],
  ["toolMs", "--tools", "Tools"],
  ["hookMs", "--hooks", "Hooks"],
];

// Stacked bar segments with a 2px surface gap between fills.
function stackSegments(x0: number, y: number, h: number, scale: number, values: number[], tipFor: (i: number) => string) {
  let x = x0;
  return values
    .map((v, i) => {
      if (v <= 0) return "";
      const w = Math.max(1, v * scale - 2);
      const seg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="var(${PARTS[i]![1]})" data-tip="${esc(tipFor(i))}"/>`;
      x += w + 2;
      return seg;
    })
    .join("");
}

function breakdownBar(width: number, b: Summary["breakdown"]) {
  const total = b.api + b.tools + b.hooks;
  if (!total) return `<p class="empty">No prompts in this window.</p>`;
  const vals = [b.api, b.tools, b.hooks];
  const segs = stackSegments(0, 0, 22, width / total, vals, (i) => `${PARTS[i]![2]}: ${fmtMs(vals[i]!)} (${pct(vals[i]! / total)})`);
  let x = 0;
  const labels = vals
    .map((v, i) => {
      const w = (v / total) * width;
      const t = w > 70 ? `<text x="${x + 2}" y="38" class="ink">${PARTS[i]![2]} ${pct(v / total)}</text>` : "";
      x += w;
      return t;
    })
    .join("");
  return `<svg width="${width}" height="44">${segs}${labels}</svg>`;
}

function promptBars(width: number, prompts: PromptBreakdown[]) {
  if (!prompts.length) return `<p class="empty">No prompts in this window.</p>`;
  const labelW = 110;
  const rowH = 20;
  const max = Math.max(...prompts.map((p) => p.apiMs + p.toolMs + p.hookMs), 1);
  const scale = (width - labelW - 70) / max;
  const rows = prompts
    .map((p, i) => {
      const y = i * rowH;
      const vals = [p.apiMs, p.toolMs, p.hookMs];
      const sum = vals.reduce((a, b) => a + b, 0);
      const name = `${clock(p.startMs)} ${p.command ?? ""}`.trim();
      const tipText = (k: number) =>
        `${name}\n${PARTS[k]![2]}: ${fmtMs(vals[k]!)}\nAPI calls ${p.apiCalls}, tool calls ${p.toolCalls}\nWall clock ~${fmtMs(p.wallMs)}, cost ${usd(p.costUsd)}`;
      return `<text x="${labelW - 8}" y="${y + 14}" text-anchor="end" class="ink">${esc(name.slice(0, 16))}</text>
        ${stackSegments(labelW, y + 4, 12, scale, vals, tipText)}
        <text x="${labelW + sum * scale + 6}" y="${y + 14}">${fmtMs(sum)}</text>`;
    })
    .join("");
  return `<svg width="${width}" height="${prompts.length * rowH}">${rows}</svg>`;
}

function latencyChart(el: HTMLElement, width: number, s: Summary["apiSeries"]) {
  const pts = s.points;
  if (!pts.some((p) => p.count)) return void (el.innerHTML = `<p class="empty">No API requests in this window.</p>`);
  const h = 170;
  const pad = { l: 44, r: 10, t: 8, b: 22 };
  const max = Math.max(...pts.map((p) => p.p95 ?? 0), 1000) * 1.1;
  const x = (i: number) => pad.l + (i / Math.max(1, pts.length - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = (key: "p50" | "p95") => {
    let d = "";
    let pen = false;
    pts.forEach((p, i) => {
      const v = p[key];
      if (v === null) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const dots = (key: "p50" | "p95", color: string) =>
    pts.map((p, i) => (p[key] === null ? "" : `<circle cx="${x(i)}" cy="${y(p[key]!)}" r="2.5" fill="var(${color})"/>`)).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const grid = ticks
    .map((v) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>
      <text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtMs(v)}</text>`)
    .join("");
  const xTicks = [0, Math.floor(pts.length / 3), Math.floor((2 * pts.length) / 3), pts.length - 1]
    .map((i, n) => `<text x="${x(i)}" y="${h - 6}" text-anchor="${n === 0 ? "start" : n === 3 ? "end" : "middle"}">${clock(pts[i]!.t)}</text>`)
    .join("");
  el.innerHTML = `${legend([["--api", "p50"], ["--api-soft", "p95"]])}
    <svg width="${width}" height="${h}">${grid}
      <line x1="${pad.l}" x2="${width - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/>
      <path d="${line("p95")}" fill="none" stroke="var(--api-soft)" stroke-width="2" stroke-dasharray="5 3"/>
      <path d="${line("p50")}" fill="none" stroke="var(--api)" stroke-width="2"/>
      ${dots("p95", "--api-soft")}${dots("p50", "--api")}${xTicks}
      <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${h - pad.b}" stroke="var(--axis)" visibility="hidden"/>
      <rect class="hit" x="${pad.l}" y="0" width="${width - pad.l - pad.r}" height="${h}" fill="transparent"/></svg>`;
  const svg = el.querySelector("svg")!;
  const cross = svg.querySelector(".cross")!;
  const hit = svg.querySelector(".hit")!;
  hit.addEventListener("mousemove", (ev) => {
    const e = ev as MouseEvent;
    const rx = e.clientX - svg.getBoundingClientRect().left;
    const i = Math.round(((rx - pad.l) / (width - pad.l - pad.r)) * (pts.length - 1));
    const p = pts[Math.max(0, Math.min(pts.length - 1, i))]!;
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    const text = p.count ? `${clock(p.t)}\np50 ${fmtMs(p.p50!)}\np95 ${fmtMs(p.p95!)}\n${p.count} requests` : `${clock(p.t)}\nno requests`;
    e.stopPropagation();
    showTip(text, e.clientX, e.clientY);
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  });
}

function statTip(r: LatencyStats, extraLines: string[] = []) {
  return [r.name, `${r.count} runs, total ${fmtMs(r.totalMs)}`, `p50 ${fmtMs(r.p50)}  p95 ${fmtMs(r.p95)}  max ${fmtMs(r.maxMs)}`, ...extraLines]
    .concat(r.failures ? [`${r.failures} failed`] : [])
    .join("\n");
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
  <p>Start Claude Code with these variables (or add them to the <code>env</code> block of <code>~/.claude/settings.json</code>):</p>
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

function render(s: Summary) {
  if (s.eventCount === 0) {
    app.innerHTML = setupHelp();
    return;
  }
  const k = s.kpis;
  const slowHook = s.hooks.find((h) => h.p95 > 2000);
  app.innerHTML = `
    <section class="kpis">
      ${kpi("API latency p50", fmtMs(k.apiP50), `p95 ${fmtMs(k.apiP95)} · ${k.apiRequests} req`)}
      ${kpi("Turn time p50", fmtMs(k.turnP50), `${k.prompts} prompts · ${k.sessions} sessions`, false, "From interaction spans when traces are on, else first-to-last event per prompt")}
      ${kpi("Time to first token", k.ttftP50 === null ? "n/a" : fmtMs(k.ttftP50), k.ttftP50 === null ? "needs traces (beta)" : "p50")}
      ${kpi("Hook time", fmtMs(k.hookTotalMs), `${pct(k.hookShare)} of in-turn time`, k.hookShare > 0.15 || !!slowHook, slowHook ? `Slowest: ${slowHook.name}, p95 ${fmtMs(slowHook.p95)}` : "")}
      ${kpi("Cost", usd(k.costUsd), `${compact(k.tokens.output)} out · ${compact(k.tokens.input)} in`)}
      ${kpi("Cache hit", pct(k.cacheHitRatio), `${compact(k.tokens.cacheRead)} read · ${compact(k.tokens.cacheCreation)} write`)}
    </section>
    <div class="card"><h2>Where turn time goes</h2>
      ${legend(PARTS.map(([, c, l]) => [c, l] as [string, string]))}
      <div id="c-breakdown"></div>
      <p class="muted" style="margin:4px 0 0;font-size:11px">Summed component time. Parallel tool calls can overlap, so parts may exceed wall clock.</p>
    </div>
    <div class="card"><h2>API latency over time</h2><div id="c-latency"></div></div>
    <div class="grid2">
      <div class="card"><h2>Hooks by total time</h2><div id="c-hooks"></div></div>
      <div class="card"><h2>Tools, skills, MCP by total time</h2><div id="c-tools"></div></div>
    </div>
    <div class="card"><h2>Recent prompts</h2><div id="c-prompts"></div></div>
    <div class="grid2">
      <div class="card"><h2>Skills</h2>${table(["Skill", "Activations", "API calls", "API time", "Cost"], s.skills.map((r) => [r.name, r.extra?.activations ?? 0, r.count, fmtMs(r.totalMs), usd(Number(r.extra?.costUsd ?? 0))]))}</div>
      <div class="card"><h2>Subagents</h2>${table(["Agent", "Runs", "p50", "Total", "Tool uses"], s.subagents.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.totalMs), r.extra?.toolUses ?? 0]))}</div>
      <div class="card"><h2>Models</h2>${table(["Model", "Requests", "p50", "p95", "Total"], s.models.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.p95), fmtMs(r.totalMs)]))}</div>
      <div class="card"><h2>Permission decisions (rules = config)</h2>${table(["Source / decision", "Count"], s.permissions)}</div>
      <div class="card"><h2>MCP server connect</h2>${table(["Server", "Connects", "p50", "Max", "Failed"], s.mcpConnections.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.maxMs), r.failures]))}</div>
      <div class="card"><h2>Errors and compaction</h2>${table(["Kind", "Count"], [...s.errors, ...(k.compactions ? [[`Compactions (${fmtMs(k.compactionMs)})`, k.compactions] as [string, number]] : [])])}</div>
    </div>`;

  const w = (id: string) => document.getElementById(id)!;
  const inner = (id: string) => w(id).clientWidth;
  w("c-breakdown").innerHTML = breakdownBar(inner("c-breakdown"), s.breakdown);
  latencyChart(w("c-latency"), inner("c-latency"), s.apiSeries);
  w("c-hooks").innerHTML = hbars(
    inner("c-hooks"),
    s.hooks.slice(0, 12).map((r) => ({
      label: r.name,
      value: r.totalMs,
      color: "--hooks",
      note: `${fmtMs(r.totalMs)} · ${r.count}×`,
      tip: statTip(r, [`blocking ${r.extra?.blocking ?? 0}, injected context ${compact(Number(r.extra?.contextChars ?? 0))} chars`]),
    })),
  );
  w("c-tools").innerHTML = hbars(
    inner("c-tools"),
    s.tools.slice(0, 12).map((r) => ({ label: r.name, value: r.totalMs, color: "--tools", note: `${fmtMs(r.totalMs)} · ${r.count}×`, tip: statTip(r) })),
  );
  w("c-prompts").innerHTML = legend(PARTS.map(([, c, l]) => [c, l] as [string, string])) + promptBars(inner("c-prompts"), s.recentPrompts);
}

let last: Summary | null = null;
async function load() {
  try {
    const res = await fetch(`/api/summary?minutes=${minutes}`);
    last = (await res.json()) as Summary;
    render(last);
    updated.textContent = `${last.eventCount} events · ${clock(last.generatedAt)}`;
  } catch (err) {
    app.innerHTML = `<div class="card"><h2>Collector unreachable</h2><p class="muted">${esc(err)}</p></div>`;
  }
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
window.addEventListener("resize", () => last && render(last));

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
// Fallback for when the socket is down, and to roll the time window forward.
setInterval(load, 30_000);
