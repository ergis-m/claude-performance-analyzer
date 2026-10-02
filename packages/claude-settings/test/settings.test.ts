import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnv, planEnv, telemetryEnv } from "../src";

const wanted = telemetryEnv(4318);
const tmp = () => mkdtempSync(join(tmpdir(), "cc-settings-"));
const original = { model: "opus", env: { ANTHROPIC_AUTH_TOKEN: "sk-secret", OTEL_LOGS_EXPORTER: "console" }, hooks: { Stop: [] } };

test("adds only missing keys and never touches existing values", () => {
  const path = join(tmp(), "settings.json");
  const raw = JSON.stringify(original, null, 4) + "\n";
  writeFileSync(path, raw);
  const out = applyEnv(path, wanted);
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(out.added).not.toContain("OTEL_LOGS_EXPORTER");
  expect(out.added).toHaveLength(Object.keys(wanted).length - 1);
  expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-secret");
  expect(after.env.OTEL_LOGS_EXPORTER).toBe("console");
  expect(after.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
  expect(after.model).toBe("opus");
  expect(after.hooks).toEqual({ Stop: [] });
  expect(readFileSync(path, "utf8")).toStartWith('{\n    "model"');
  expect(readFileSync(out.backup!, "utf8")).toBe(raw);
  expect(out.plan.missing).toEqual([]);
  expect(out.plan.conflicts).toEqual(["OTEL_LOGS_EXPORTER"]);
  // second run is a no-op without a new backup
  expect(applyEnv(path, wanted).backup).toBeNull();
});

test("edits text in place: comments, key order and spacing survive", () => {
  const path = join(tmp(), "settings.json");
  const raw = `{
  // personal notes
  "permissions": { "allow": ["Bash(ls:*)"] },
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-secret",
  },
  "model":   "opus"
}
`;
  writeFileSync(path, raw);
  applyEnv(path, wanted);
  const after = readFileSync(path, "utf8");
  for (const line of ["  // personal notes", '  "permissions": { "allow": ["Bash(ls:*)"] },', '    "ANTHROPIC_AUTH_TOKEN": "sk-secret",', '  "model":   "opus"']) expect(after).toContain(line);
  expect(after.indexOf("permissions")).toBeLessThan(after.indexOf('"model"'));
  expect(after).toContain('    "CLAUDE_CODE_ENABLE_TELEMETRY": "1"');
  expect(planEnv(path, wanted).missing).toEqual([]);
});

test("plan reports key names only, never values", () => {
  const path = join(tmp(), "settings.json");
  writeFileSync(path, JSON.stringify(original));
  expect(JSON.stringify(planEnv(path, wanted))).not.toContain("sk-secret");
});

test("refuses invalid JSON and leaves the file alone", () => {
  const path = join(tmp(), "settings.json");
  writeFileSync(path, "{ broken");
  expect(planEnv(path, wanted).error).toContain("not valid JSON");
  expect(() => applyEnv(path, wanted)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("{ broken");
});

test("writes through a symlink and keeps the link", () => {
  const dir = tmp();
  const real = join(dir, "dotfiles-settings.json");
  const link = join(dir, "settings.json");
  writeFileSync(real, JSON.stringify({ env: {} }));
  symlinkSync(real, link);
  applyEnv(link, wanted);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8")).env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
});

test("creates settings.json when absent", () => {
  const path = join(tmp(), "settings.json");
  const out = applyEnv(path, wanted);
  expect(out.backup).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).env).toEqual(wanted);
});
