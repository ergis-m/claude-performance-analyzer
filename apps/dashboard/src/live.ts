// Live activity: WebSocket feed of events as Claude Code exports them.
import type { LiveEvent } from "@cpa/analytics";
import { fmtMs } from "@cpa/analytics";

const FEED_MAX = 40;
const STALE_HOOK_MS = 120_000;
const KIND_COLOR: Record<string, string> = { api: "--api", tool: "--tools", hook: "--hooks", error: "--critical" };

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clockSec = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function startLive(root: HTMLElement, onData: () => void) {
  root.innerHTML = `<div class="live-head">
      <span class="dot" id="live-dot"></span><strong id="live-state">Connecting</strong>
      <span class="muted" id="live-ago"></span><span id="live-running"></span></div>
    <div class="feed" id="live-feed"><p class="empty">Waiting for events...</p></div>`;
  const dot = root.querySelector<HTMLElement>("#live-dot")!;
  const state = root.querySelector<HTMLElement>("#live-state")!;
  const ago = root.querySelector<HTMLElement>("#live-ago")!;
  const running = root.querySelector<HTMLElement>("#live-running")!;
  const feedEl = root.querySelector<HTMLElement>("#live-feed")!;

  let feed: LiveEvent[] = [];
  let lastSeen = 0;
  let freshCount = 0;
  // Hooks that started but have not completed yet, keyed by session and hook name.
  const inFlight = new Map<string, number>();

  function renderFeed() {
    const rows = feed.filter((e) => e.kind !== "hook_start");
    if (!rows.length) return;
    const maxMs = Math.max(...rows.map((e) => e.ms ?? 0), 1000);
    feedEl.innerHTML = rows
      .map((e, i) => {
        const color = KIND_COLOR[e.kind] ?? "--muted";
        const bar = e.ms ? `<span class="bar" style="width:${Math.max(2, (e.ms / maxMs) * 100)}%;background:var(${color})"></span>` : "";
        return `<div class="row${i < freshCount ? " fresh" : ""}${e.ok ? "" : " bad"}">
          <span class="t">${clockSec(e.tsMs)}</span>
          <span class="chip" style="background:var(${color})"></span>
          <span class="lbl" title="${esc(e.label)}">${esc(e.label)}${e.ok || e.label.endsWith("failed") ? "" : " (failed)"}</span>
          <span class="track">${bar}</span>
          <span class="ms">${e.ms ? fmtMs(e.ms) : ""}</span></div>`;
      })
      .join("");
    freshCount = 0;
  }

  function track(events: LiveEvent[]) {
    for (const e of events) {
      const key = `${e.sessionId}|${e.label}`;
      if (e.kind === "hook_start") inFlight.set(key, e.tsMs);
      else if (e.kind === "hook") inFlight.delete(key);
    }
  }

  function tick() {
    const now = Date.now();
    ago.textContent = lastSeen ? `last event ${fmtMs(Math.max(0, now - lastSeen))} ago` : "";
    for (const [k, t] of inFlight) if (now - t > STALE_HOOK_MS) inFlight.delete(k);
    running.innerHTML = [...inFlight]
      .map(([k, t]) => `<span class="running">hook ${esc(k.split("|")[1])} running ${fmtMs(now - t)}</span>`)
      .join("");
  }

  async function backlog() {
    try {
      const events = (await (await fetch("/api/live")).json()) as LiveEvent[];
      feed = events;
      lastSeen = events[0]?.tsMs ?? 0;
      renderFeed();
    } catch {}
  }

  let retryMs = 1000;
  function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      retryMs = 1000;
      dot.className = "dot on";
      state.textContent = "Live";
      backlog();
    };
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data) as { type: string; events: LiveEvent[]; changed: number };
      if (data.type !== "events") return;
      const fresh = [...data.events].sort((a, b) => b.tsMs - a.tsMs);
      track(data.events);
      if (fresh.length) {
        lastSeen = Math.max(lastSeen, fresh[0]!.tsMs);
        freshCount = fresh.filter((e) => e.kind !== "hook_start").length;
        feed = [...fresh, ...feed].slice(0, FEED_MAX);
        renderFeed();
      }
      if (data.changed) onData();
    };
    ws.onclose = () => {
      dot.className = "dot";
      state.textContent = "Reconnecting";
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    };
  }

  connect();
  setInterval(tick, 250);
}
