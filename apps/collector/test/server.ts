import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the collector on a random port with data and settings in a temp dir.
export async function startCollector(env: Record<string, string> = {}) {
  const port = 14000 + Math.floor(Math.random() * 3000);
  const dir = mkdtempSync(join(tmpdir(), "cc-collector-"));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, PORT: String(port), CC_TELEMETRY_DIR: dir, CC_SETTINGS_PATH: join(dir, "settings.json"), NODE_ENV: "production", ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${url}/api/live`).then((r) => r.ok, () => false)) return { port, url, stop: () => proc.kill() };
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error("collector did not start");
}
