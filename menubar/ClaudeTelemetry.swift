import AppKit
import WebKit

// Dashboard and status endpoints served by the local collector.
private let dashboardURL = URL(string: "http://127.0.0.1:4318/")!
private let statusURL = URL(string: "http://127.0.0.1:4318/api/status")!

// MARK: - Status payload

struct StatusPayload: Decodable {
    let label: String
    let state: String
    let tooltip: String
}

enum FetchResult {
    case success(StatusPayload)
    case unreachable
}

// MARK: - Poller

// Polls the collector's status endpoint on a timer and reports results on the main actor.
@MainActor
final class TelemetryPoller {
    private let session: URLSession
    private var timer: Timer?
    var onUpdate: ((FetchResult) -> Void)?

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.0
        config.timeoutIntervalForResource = 2.0
        session = URLSession(configuration: config)
    }

    func start() {
        pollNow()
        let newTimer = Timer(timeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.pollNow()
            }
        }
        RunLoop.main.add(newTimer, forMode: .common)
        timer = newTimer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func pollNow() {
        Task {
            let result = await fetchStatus()
            onUpdate?(result)
        }
    }

    private func fetchStatus() async -> FetchResult {
        do {
            let (data, _) = try await session.data(from: statusURL)
            let payload = try JSONDecoder().decode(StatusPayload.self, from: data)
            return .success(payload)
        } catch {
            return .unreachable
        }
    }
}

// MARK: - Status item controller

// Owns the status bar item, its popover (web dashboard) and its context menu.
@MainActor
final class StatusItemController: NSObject, WKNavigationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let poller = TelemetryPoller()
    private let contextMenu = NSMenu()

    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 820, height: 680), configuration: configuration)
        view.navigationDelegate = self
        return view
    }()

    private lazy var popover: NSPopover = {
        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentSize = NSSize(width: 820, height: 680)
        let vc = NSViewController()
        vc.view = webView
        pop.contentViewController = vc
        return pop
    }()

    override init() {
        super.init()
        configureButton()
        configureMenu()
        poller.onUpdate = { [weak self] result in
            self?.render(result)
        }
    }

    func start() {
        render(.unreachable)
        poller.start()
    }

    // MARK: Button

    private func configureButton() {
        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.imagePosition = .imageLeading
    }

    private func render(_ result: FetchResult) {
        guard let button = statusItem.button else { return }

        let symbolConfig = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        let image = NSImage(
            systemSymbolName: "gauge.with.dots.needle.67percent",
            accessibilityDescription: "Claude Code telemetry"
        )?.withSymbolConfiguration(symbolConfig)
        image?.isTemplate = true
        button.image = image

        switch result {
        case .success(let payload):
            let color: NSColor = payload.state == "slow" ? .systemOrange : .labelColor
            button.attributedTitle = NSAttributedString(
                string: " " + payload.label,
                attributes: [
                    .foregroundColor: color,
                    .font: NSFont.menuBarFont(ofSize: 0)
                ]
            )
            button.toolTip = payload.tooltip
        case .unreachable:
            button.attributedTitle = NSAttributedString(
                string: " off",
                attributes: [
                    .foregroundColor: NSColor.labelColor,
                    .font: NSFont.menuBarFont(ofSize: 0)
                ]
            )
            button.toolTip = "Collector not running on :4318"
        }
    }

    // MARK: Click handling

    @objc private func statusItemClicked(_ sender: Any?) {
        guard let event = NSApp.currentEvent, let button = statusItem.button else { return }
        if event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            NSMenu.popUpContextMenu(contextMenu, with: event, for: button)
        } else {
            togglePopover()
        }
    }

    private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            reloadWebView()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    // MARK: Web view

    private func reloadWebView() {
        webView.load(URLRequest(url: dashboardURL, timeoutInterval: 5.0))
    }

    private func showOfflineMessage() {
        let html = """
        <html>
        <body style="font-family: -apple-system, sans-serif; padding: 48px; text-align: center; color: #333;">
        <h2>Collector not running.</h2>
        <p>Start it with: <code>bun run start</code></p>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showOfflineMessage()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOfflineMessage()
    }

    // MARK: Menu

    private func configureMenu() {
        let openItem = NSMenuItem(title: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
        openItem.target = self
        contextMenu.addItem(openItem)

        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadAction), keyEquivalent: "")
        reloadItem.target = self
        contextMenu.addItem(reloadItem)

        contextMenu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitAction), keyEquivalent: "")
        quitItem.target = self
        contextMenu.addItem(quitItem)
    }

    @objc private func openInBrowser() {
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc private func reloadAction() {
        poller.pollNow()
        if popover.isShown {
            reloadWebView()
        }
    }

    @objc private func quitAction() {
        NSApp.terminate(nil)
    }
}

// MARK: - App delegate

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = StatusItemController()
        statusController = controller
        controller.start()
    }
}

// MARK: - Entry point

@main
@MainActor
struct ClaudeTelemetryMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
