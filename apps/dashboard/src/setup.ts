// Card that offers to add the telemetry env vars to Claude Code settings.
import type { EnvPlan } from "@cpa/claude-settings";

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const chips = (keys: string[]) => keys.map((k) => `<code class="key">${esc(k)}</code>`).join(" ");

export async function startSetup(root: HTMLElement) {
  let plan: EnvPlan;
  try {
    plan = await (await fetch("/api/setup")).json();
  } catch {
    return;
  }
  render(root, plan);
}

function render(root: HTMLElement, plan: EnvPlan, note = "") {
  if (!plan.error && !plan.missing.length && !plan.conflicts.length && !note) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const conflicts = plan.conflicts.length
    ? `<p class="muted">Left unchanged, already set to another value: ${chips(plan.conflicts)}. Data may not reach this dashboard until you change them by hand.</p>`
    : "";
  const action = plan.error
    ? `<p class="bad">Cannot update settings: ${esc(plan.error)}</p>`
    : plan.missing.length
      ? `<p>Missing in <code>${esc(plan.path)}</code> env: ${chips(plan.missing)}</p>
         <button id="setup-apply" class="primary">Add ${plan.missing.length} missing setting${plan.missing.length > 1 ? "s" : ""}</button>
         <span class="muted">Existing values are never changed. A backup is written first.</span>`
      : "";
  root.innerHTML = `<h2>Send Claude Code telemetry here</h2>${action}${conflicts}${note}`;
  root.querySelector<HTMLButtonElement>("#setup-apply")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Updating...";
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? res.statusText);
      const backup = out.backup ? ` Backup: <code>${esc(out.backup)}</code>.` : "";
      render(root, out.plan, `<p class="ok">Added ${chips(out.added)}.${backup} Restart Claude Code sessions to start sending data.</p>`);
    } catch (err) {
      render(root, plan, `<p class="bad">Update failed: ${esc((err as Error).message)}</p>`);
    }
  });
}
