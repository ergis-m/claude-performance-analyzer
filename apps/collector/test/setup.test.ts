import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCollector } from "./server";

const original = { model: "opus", env: { ANTHROPIC_AUTH_TOKEN: "sk-secret", OTEL_LOGS_EXPORTER: "console" }, hooks: { Stop: [] } };
const dir = mkdtempSync(join(tmpdir(), "cc-settings-"));
const path = join(dir, "settings.json");
let collector: Awaited<ReturnType<typeof startCollector>>;
beforeAll(async () => {
  writeFileSync(path, JSON.stringify(original));
  collector = await startCollector({ CC_SETTINGS_PATH: path });
});
afterAll(() => collector.stop());

test("endpoint rejects posts that do not come from the dashboard", async () => {
  const url = `${collector.url}/api/setup`;
  const json = { "content-type": "application/json" };
  expect((await fetch(url, { method: "POST", headers: json, body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { origin: collector.url, "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
  expect(readdirSync(dir)).toEqual(["settings.json"]);
});

test("endpoint applies settings for the dashboard origin", async () => {
  const res = await fetch(`${collector.url}/api/setup`, {
    method: "POST",
    headers: { origin: collector.url, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.added).toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
  expect(JSON.stringify(out)).not.toContain("sk-secret");
  expect(existsSync(out.backup)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(collector.url);
});
