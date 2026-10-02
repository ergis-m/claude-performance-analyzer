// Adds the telemetry variables to the "env" block of Claude Code's user settings.
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function telemetryEnv(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
    OTEL_LOG_TOOL_DETAILS: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
  };
}

export function settingsPath(): string {
  return process.env.CC_SETTINGS_PATH ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

// Only key names leave this module. The env block holds secrets such as ANTHROPIC_AUTH_TOKEN.
export interface EnvPlan {
  path: string;
  exists: boolean;
  missing: string[];
  present: string[];
  conflicts: string[];
  error: string | null;
}

function read(path: string): { settings: Record<string, any> | null; raw: string | null; error: string | null } {
  if (!existsSync(path)) return { settings: {}, raw: null, error: null };
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { settings: null, raw, error: "settings.json is not a JSON object" };
    if (parsed.env !== undefined && (typeof parsed.env !== "object" || parsed.env === null || Array.isArray(parsed.env)))
      return { settings: null, raw, error: '"env" in settings.json is not an object' };
    return { settings: parsed, raw, error: null };
  } catch (err) {
    return { settings: null, raw, error: `settings.json is not valid JSON: ${(err as Error).message}` };
  }
}

export function planEnv(path: string, wanted: Record<string, string>): EnvPlan {
  const { settings, error } = read(path);
  const plan: EnvPlan = { path, exists: existsSync(path), missing: [], present: [], conflicts: [], error };
  if (!settings) return plan;
  const env = settings.env ?? {};
  for (const [key, value] of Object.entries(wanted)) {
    if (!(key in env)) plan.missing.push(key);
    else if (String(env[key]) === value) plan.present.push(key);
    else plan.conflicts.push(key);
  }
  return plan;
}

// Keep the file's own indent so the diff stays small.
function detectIndent(raw: string | null): string | number {
  const m = raw?.match(/^\{\r?\n([ \t]+)"/);
  return m ? m[1]! : 2;
}

// Adds missing keys only. Existing values, including conflicting ones, are never changed.
export function applyEnv(path: string, wanted: Record<string, string>, nowMs = Date.now()) {
  const { settings, raw, error } = read(path);
  if (!settings) throw new Error(error ?? "cannot read settings.json");
  const plan = planEnv(path, wanted);
  if (!plan.missing.length) return { added: [] as string[], backup: null as string | null, plan };

  settings.env = { ...(settings.env ?? {}) };
  for (const key of plan.missing) settings.env[key] = wanted[key];

  // Write through a symlink to its target, so a dotfiles link stays a link.
  const target = existsSync(path) ? realpathSync(path) : path;
  let backup: string | null = null;
  let mode = 0o600;
  if (raw !== null) {
    mode = statSync(target).mode & 0o777;
    backup = `${target}.bak-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(target, backup);
    chmodSync(backup, mode);
  }
  const tmp = join(dirname(target), `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(settings, null, detectIndent(raw)) + (raw === null || raw.endsWith("\n") ? "\n" : ""), { mode });
  renameSync(tmp, target);
  return { added: plan.missing, backup, plan: planEnv(path, wanted) };
}
