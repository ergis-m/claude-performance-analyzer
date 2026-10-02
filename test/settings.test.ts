import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnv, planEnv, telemetryEnv } from "../src/settings";

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


const PORT = 15000 + Math.floor(Math.random() * 1000);
const dir = tmp();
const path = join(dir, "settings.json");
let proc: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  writeFileSync(path, JSON.stringify(original));
  proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), CC_TELEMETRY_DIR: tmp(), CC_SETTINGS_PATH: path, NODE_ENV: "production" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/setup`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});
afterAll(() => proc.kill());

test("endpoint rejects posts that do not come from the dashboard", async () => {
  const url = `http://127.0.0.1:${PORT}/api/setup`;
  const json = { "content-type": "application/json" };
  expect((await fetch(url, { method: "POST", headers: json, body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { origin: `http://127.0.0.1:${PORT}`, "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
  expect(readdirSync(dir)).toEqual(["settings.json"]);
});

test("endpoint applies settings for the dashboard origin", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/setup`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.added).toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
  expect(JSON.stringify(out)).not.toContain("sk-secret");
  expect(existsSync(out.backup)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${PORT}`);
});
