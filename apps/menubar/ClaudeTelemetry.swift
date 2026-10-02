import AppKit
import Charts
import SwiftUI

// Dashboard and JSON endpoints served by the local collector.
private let collectorURL = URL(string: "http://127.0.0.1:4318/")!

// MARK: - Payloads (the fields of src/analytics.ts the panel shows)

struct Status: Decodable {
    let label: String
    let state: String
}

struct Stats: Decodable {
    let name: String
    let totalMs: Double
    let p95: Double
}

struct Summary: Decodable {
    struct Kpis: Decodable {
        let sessions: Int
        let apiP50: Double
        let apiP95: Double
        let ttftP50: Double?
        let turnP50: Double
        let costUsd: Double
        let cacheHitRatio: Double
    }
    struct Breakdown: Decodable {
        let api: Double
        let tools: Double
        let hooks: Double
    }
    struct Point: Decodable {
        let t: Double
        let p50: Double?
        let p95: Double?
        let count: Int
    }
    struct Series: Decodable {
        let points: [Point]
    }

    let eventCount: Int
    let kpis: Kpis
    let breakdown: Breakdown
    let apiSeries: Series
    let hooks: [Stats]
    let tools: [Stats]
}

struct LiveEvent: Decodable {
    let tsMs: Double
    let kind: String
    let label: String
    let ms: Double?
    let ok: Bool
}

func fmtMs(_ ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    if ms < 60_000 { return String(format: "%.1fs", ms / 1000) }
    return String(format: "%.1fm", ms / 60_000)
}

func date(_ ms: Double) -> Date {
    Date(timeIntervalSince1970: ms / 1000)
}

// MARK: - Model

// Polls the status label all the time, and the summary and live feed only while the panel is open.
@MainActor
@Observable
final class Telemetry {
    var status: Status?
    var summary: Summary?
    var summaryError: String?
    var live: [LiveEvent] = []
    var updatedAt: Date?
    var panelOpen = false {
        didSet { if panelOpen != oldValue { restartPanelPolling() } }
    }
    var minutes = UserDefaults.standard.object(forKey: "window") as? Int ?? 60 {
        didSet {
            UserDefaults.standard.set(minutes, forKey: "window")
            summary = nil
            summaryError = nil
            restartPanelPolling()
        }
    }

    @ObservationIgnored private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.0
        config.timeoutIntervalForResource = 5.0
        return URLSession(configuration: config)
    }()
    @ObservationIgnored private var panelTask: Task<Void, Never>?

    init() {
        // Status runs on its own loop so slow summary requests never delay the label.
        Task {
            while true {
                status = try? await get("api/status")
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // One panel loop at a time: closing the panel or switching window cancels the old one,
    // so a late response can never overwrite newer data.
    private func restartPanelPolling() {
        panelTask?.cancel()
        panelTask = nil
        guard panelOpen else { return }
        panelTask = Task {
            while !Task.isCancelled {
                await refreshPanel()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func refreshPanel() async {
        do {
            let newSummary: Summary = try await get("api/summary?minutes=\(minutes)")
            let newLive: [LiveEvent]? = try? await get("api/live")
            guard !Task.isCancelled else { return }
            summary = newSummary
            summaryError = nil
            live = newLive ?? live
            updatedAt = .now
        } catch {
            guard !Task.isCancelled else { return }
            summaryError = error.localizedDescription
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await session.data(from: URL(string: path, relativeTo: collectorURL)!)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - Menu bar label

struct MenuBarLabel: View {
    let status: Status?

    var body: some View {
        // MenuBarExtra draws the label as a template, so "slow" swaps the symbol instead of tinting.
        let slow = status?.state == "slow"
        HStack(spacing: 3) {
            Image(systemName: slow ? "exclamationmark.triangle.fill" : "gauge.with.dots.needle.67percent")
            Text(status?.label ?? "off").monospacedDigit()
        }
        .accessibilityLabel("Claude Code telemetry")
    }
}

// MARK: - Panel

struct PanelView: View {
    @Bindable var model: Telemetry

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            content
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 360)
        .onAppear { model.panelOpen = true }
        .onDisappear { model.panelOpen = false }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Claude Code").font(.headline)
                HStack(spacing: 5) {
                    Circle().fill(stateColor).frame(width: 7, height: 7)
                    Text(stateText)
                    if let updatedAt = model.updatedAt, model.status != nil {
                        Text("· updated \(Text(updatedAt, style: .relative)) ago")
                    }
                    // Keep the last numbers on a failed refresh, but say they are stale.
                    if model.summaryError != nil, model.summary != nil, model.status != nil {
                        Text("· refresh failed").foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Window", selection: $model.minutes) {
                Text("15m").tag(15)
                Text("1h").tag(60)
                Text("24h").tag(1440)
                Text("7d").tag(10080)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
    }

    private var stateColor: Color {
        switch model.status?.state {
        case nil: .red
        case "slow": .orange
        case "idle": .secondary
        default: .green
        }
    }

    private var stateText: String {
        switch model.status?.state {
        case nil: "Collector offline"
        case "slow": "Hooks slow"
        case "idle": "Idle"
        default: "OK"
        }
    }

    @ViewBuilder private var content: some View {
        if model.status == nil {
            EmptyState(
                title: "Collector not running",
                symbol: "bolt.horizontal.circle",
                message: "Start it with `bun run start`."
            )
        } else if let s = model.summary {
            if s.eventCount == 0 {
                EmptyState(
                    title: "No telemetry yet",
                    symbol: "antenna.radiowaves.left.and.right",
                    message: "Nothing in this window. Enable telemetry for Claude Code from the dashboard."
                )
            } else {
                SummaryView(summary: s, live: model.live)
            }
        } else if let error = model.summaryError {
            EmptyState(
                title: "Couldn't load summary",
                symbol: "exclamationmark.triangle",
                message: "\(error) Retrying every 2s."
            )
        } else {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 80)
        }
    }

    private var footer: some View {
        HStack {
            Button("Open Dashboard", systemImage: "arrow.up.right.square") {
                NSWorkspace.shared.open(collectorURL)
            }
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
    }
}

// ContentUnavailableView wraps itself in a ScrollView, which collapses to zero height in a
// self-sizing menu bar panel. A plain stack sizes to its content.
struct EmptyState: View {
    let title: String
    let symbol: String
    let message: LocalizedStringKey

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

struct SummaryView: View {
    let summary: Summary
    let live: [LiveEvent]

    var body: some View {
        let k = summary.kpis
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Kpi(title: "API p50", value: fmtMs(k.apiP50))
                    Kpi(title: "API p95", value: fmtMs(k.apiP95))
                    Kpi(title: "TTFT", value: k.ttftP50.map(fmtMs) ?? "–")
                    Kpi(title: "Turn", value: fmtMs(k.turnP50))
                }
                Text("\(k.costUsd, format: .currency(code: "USD")) · cache \(k.cacheHitRatio, format: .percent.precision(.fractionLength(0))) · \(k.sessions) sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            LatencyChart(points: summary.apiSeries.points)
            Breakdown(breakdown: summary.breakdown)
            StatsList(
                title: "Slowest hooks",
                rows: Array(summary.hooks.sorted { $0.p95 > $1.p95 }.prefix(3)),
                value: { "p95 \(fmtMs($0.p95))" },
                // Same threshold the collector uses for the "slow" state.
                warn: { $0.p95 > 2000 }
            )
            StatsList(
                title: "Tools by total time",
                rows: Array(summary.tools.prefix(3)),
                value: { fmtMs($0.totalMs) },
                warn: { _ in false }
            )
            LiveFeed(events: Array(live.filter { $0.kind != "hook_start" }.prefix(6)))
        }
    }
}

struct Kpi: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
    }
}

struct Swatch: View {
    let color: Color
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }
}

// One plotted value. `segment` changes at every empty bucket so the line breaks there,
// like the dashboard's connectNulls: false.
struct LatencySample: Identifiable {
    let id: Int
    let time: Date
    let ms: Double
    let series: String
    let segment: String

    static func from(_ points: [Summary.Point]) -> [LatencySample] {
        var samples: [LatencySample] = []
        for (series, value) in [("p50", \Summary.Point.p50), ("p95", \Summary.Point.p95)] {
            var segment = 0
            var inGap = false
            for p in points {
                guard let ms = p[keyPath: value] else {
                    if !inGap { segment += 1 }
                    inGap = true
                    continue
                }
                inGap = false
                samples.append(LatencySample(id: samples.count, time: date(p.t), ms: ms, series: series, segment: "\(series)-\(segment)"))
            }
        }
        return samples
    }
}

struct LatencyChart: View {
    let points: [Summary.Point]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionTitle("API latency")
                Spacer()
                Swatch(color: .blue, text: "p50")
                Swatch(color: .blue.opacity(0.35), text: "p95")
            }
            if points.contains(where: { $0.count > 0 }) {
                chart
            } else {
                Text("No API requests in this window.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 90)
            }
        }
    }

    private var chart: some View {
        Chart(LatencySample.from(points)) { s in
            LineMark(x: .value("Time", s.time), y: .value("Latency", s.ms), series: .value("Segment", s.segment))
                .foregroundStyle(by: .value("Series", s.series))
                .lineStyle(s.series == "p95" ? StrokeStyle(lineWidth: 2, dash: [4, 3]) : StrokeStyle(lineWidth: 2))
                .interpolationMethod(.monotone)
            // Points keep a lone bucket visible, since a one-point line draws nothing.
            PointMark(x: .value("Time", s.time), y: .value("Latency", s.ms))
                .foregroundStyle(by: .value("Series", s.series))
                .symbolSize(10)
        }
        // Span the whole window, not just the buckets that have requests.
        .chartXScale(domain: date(points.first?.t ?? 0)...date(points.last?.t ?? 0))
        .chartYScale(domain: .automatic(includesZero: true))
        .chartForegroundStyleScale(["p50": Color.blue, "p95": Color.blue.opacity(0.35)])
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { v in
                AxisGridLine()
                AxisValueLabel { if let ms = v.as(Double.self) { Text(fmtMs(ms)) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisValueLabel(format: .dateTime.hour().minute(), collisionResolution: .greedy(minimumSpacing: 6))
            }
        }
        .frame(height: 90)
    }
}

struct Breakdown: View {
    let breakdown: Summary.Breakdown

    var body: some View {
        let parts = [("API", breakdown.api, Color.blue), ("Tools", breakdown.tools, Color.purple), ("Hooks", breakdown.hooks, Color.orange)]
        let total = parts.reduce(0) { $0 + $1.1 }
        if total > 0 {
            VStack(alignment: .leading, spacing: 5) {
                SectionTitle("Where turn time goes")
                Chart(parts, id: \.0) { name, ms, _ in
                    BarMark(x: .value("Time", ms), stacking: .normalized)
                        .foregroundStyle(by: .value("Part", name))
                }
                .chartForegroundStyleScale(domain: parts.map(\.0), range: parts.map(\.2))
                .chartXAxis(.hidden)
                .chartLegend(.hidden)
                .clipShape(.capsule)
                .frame(height: 8)
                HStack(spacing: 12) {
                    ForEach(parts, id: \.0) { name, ms, color in
                        Swatch(color: color, text: "\(name) \((ms / total).formatted(.percent.precision(.fractionLength(0))))")
                    }
                }
            }
        }
    }
}

struct StatsList: View {
    let title: String
    let rows: [Stats]
    let value: (Stats) -> String
    let warn: (Stats) -> Bool

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle(title)
                ForEach(rows, id: \.name) { row in
                    HStack(spacing: 6) {
                        Text(row.name).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        if warn(row) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        }
                        Text(value(row)).foregroundStyle(.secondary).monospacedDigit()
                    }
                    .font(.callout)
                }
            }
        }
    }
}

struct LiveFeed: View {
    let events: [LiveEvent]

    var body: some View {
        if !events.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle("Live")
                ForEach(Array(events.enumerated()), id: \.offset) { _, e in
                    HStack(spacing: 6) {
                        Text(date(e.tsMs), format: .dateTime.hour().minute().second())
                            .foregroundStyle(.tertiary)
                        Image(systemName: Self.symbol(e.kind))
                            .foregroundStyle(e.ok ? Color.secondary : Color.red)
                            .frame(width: 16)
                        Text(e.label).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        if let ms = e.ms {
                            Text(fmtMs(ms)).foregroundStyle(.secondary)
                        }
                    }
                    .font(.callout)
                    .monospacedDigit()
                }
            }
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "prompt": "text.bubble"
        case "api": "cloud"
        case "tool": "wrench.and.screwdriver"
        case "hook": "bolt"
        case "agent": "person.2"
        case "skill": "sparkles"
        case "mcp": "server.rack"
        case "error": "xmark.octagon"
        case "compaction": "arrow.down.right.and.arrow.up.left"
        default: "circle"
        }
    }
}

// MARK: - App

@main
struct ClaudeTelemetryApp: App {
    @State private var model = Telemetry()

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model)
        } label: {
            MenuBarLabel(status: model.status)
        }
        .menuBarExtraStyle(.window)
    }
}
