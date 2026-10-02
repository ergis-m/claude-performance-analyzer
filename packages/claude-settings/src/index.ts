// Adds the telemetry variables to the "env" block of Claude Code's user settings.
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
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
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length) {
    const e = errors[0]!;
    return { settings: null, raw, error: `settings.json is not valid JSON: ${printParseErrorCode(e.error)} at offset ${e.offset}` };
  }
  {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { settings: null, raw, error: "settings.json is not a JSON object" };
    if (parsed.env !== undefined && (typeof parsed.env !== "object" || parsed.env === null || Array.isArray(parsed.env)))
      return { settings: null, raw, error: '"env" in settings.json is not an object' };
    return { settings: parsed, raw, error: null };
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

// Match the file's own indent and line endings so the diff stays small.
function formatting(raw: string) {
  const indent = raw.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? "  ";
  return { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: raw.includes("\r\n") ? "\r\n" : "\n" };
}

// Adds missing keys only. Existing values, including conflicting ones, are never changed.
export function applyEnv(path: string, wanted: Record<string, string>, nowMs = Date.now()) {
  const { settings, raw, error } = read(path);
  if (!settings) throw new Error(error ?? "cannot read settings.json");
  const plan = planEnv(path, wanted);
  if (!plan.missing.length) return { added: [] as string[], backup: null as string | null, plan };

  // Edit the text in place: untouched keys, order, comments and spacing survive.
  let text = raw ?? "{}\n";
  const fmt = formatting(text);
  for (const key of plan.missing) text = applyEdits(text, modify(text, ["env", key], wanted[key], { formattingOptions: fmt }));

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
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, target);
  return { added: plan.missing, backup, plan: planEnv(path, wanted) };
}
