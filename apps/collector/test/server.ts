import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Asks the OS for a free port. The collector needs a fixed PORT for its origin check, so port 0 will not do.
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

// Runs the collector on a free port with data and settings in a temp dir.
export async function startCollector(env: Record<string, string> = {}) {
  const port = freePort();
  const dir = mkdtempSync(join(tmpdir(), "cc-collector-"));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, PORT: String(port), CC_TELEMETRY_DIR: dir, CC_SETTINGS_PATH: join(dir, "settings.json"), NODE_ENV: "production", ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    // A child that exited lost the port, so whatever answers is some other server.
    if (proc.exitCode !== null) break;
    if ((await fetch(`${url}/api/live`).then((r) => r.ok, () => false)) && proc.exitCode === null) return { port, url, stop: () => proc.kill() };
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`collector did not start (exit code ${proc.exitCode})`);
}
