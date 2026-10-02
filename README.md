# claude-performance-analyzer

macOS menu bar widget for Claude Code telemetry. Shows where turn time goes: model latency, tools, hooks, skills, subagents, MCP startup.

## Layout

Bun workspaces. Each package has its own `src/` and `test/`.

- `apps/collector`: Bun OTLP receiver (http/json or http/protobuf, gzip ok) on `127.0.0.1:4318`, stores to `~/.claude-telemetry/telemetry.sqlite` (14 day retention), serves the dashboard and `/api/summary`, `/api/status`.
- `apps/dashboard`: browser UI, bundled by the collector through its HTML import.
- `apps/menubar`: SwiftUI menu bar app. Label is API p50 latency over the last 15 min, with a warning icon when hooks are slow. Click opens a native summary panel (latency chart, turn time split, slowest hooks and tools, live feed); "Open Dashboard" opens the full web dashboard.
- `packages/otlp`: OTLP http/json and http/protobuf decoding into rows.
- `packages/analytics`: summaries, percentiles, turn timelines. Shared by the collector and the dashboard.
- `packages/claude-settings`: adds the telemetry variables to Claude Code's `settings.json`.

## Run

```bash
bun install
bun run start      # collector + dashboard
bun run app        # build and open the menu bar app
bun test           # all packages
bun run typecheck
```

Point Claude Code at the collector. The dashboard has a button that adds any missing variables to the `env` block of `~/.claude/settings.json` (existing values are kept, a backup is written next to the file). Or set them yourself:

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # http/protobuf works too; grpc does not
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_LOGS_EXPORT_INTERVAL=1000            # how "real time" the live feed is
OTEL_LOG_TOOL_DETAILS=1                 # real skill, MCP and subagent names
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # optional: time to first token, turn spans
OTEL_TRACES_EXPORTER=otlp
```

## Limits

- Only data from sessions started after telemetry is on. No backfill.
- Rules have no timing in telemetry. They only appear as `source: config` permission decisions.
- Hook timing is per hook event and matcher (`PreToolUse:Bash`), not per script. Per-script detail needs detailed beta tracing.
- "Where turn time goes" sums component durations; parallel tool calls overlap.

## Third-party files

`packages/otlp/proto/` holds the OTLP `.proto` definitions from [open-telemetry/opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) v1.11.1, Apache 2.0 (see `packages/otlp/proto/LICENSE`).
