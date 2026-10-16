// Dune for iOS: the website's Dune game, bundled into the app and shown full screen in a web view.
// The game's files (dune.html and the site scripts it uses) are copied into the app's "web" folder at
// build time and served from the dune://app/ address, so the game works offline. Signing in and the
// leaderboard still go to the website's database when there's a connection.

import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = GameViewController()
        window?.makeKeyAndVisible()
        return true
    }
}

final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private static let background = UIColor(red: 5 / 255, green: 6 / 255, blue: 10 / 255, alpha: 1)

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "dune")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = .default()   // keeps the best score, look and sign-in between launches

        // things that only make sense on the website: the link back to the Games page, the "new version"
        // bar, and Google sign-in (Google doesn't allow it inside apps; the email code works)
        let css = """
        a[href="/games.html"]{ visibility: hidden !important; }
        #g-in{ display: none !important; }
        html, body{ -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
        """
        let js = "window.__duneApp = true; (function(){ var s = document.createElement('style'); s.textContent = \(jsString(css)); document.documentElement.appendChild(s); })();"
        config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false

        let root = UIView()
        root.backgroundColor = Self.background
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: "dune://app/dune.html")!))
    }

    // links to other websites open in Safari; the game itself stays in the app
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme != "dune", action.targetFrame?.isMainFrame ?? true,
           ["http", "https", "mailto"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // iOS can drop the web view's process when the app is in the background; start the game again
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// Serves the files in the app's "web" folder at dune://app/<path>.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.url(forResource: "web", withExtension: nil)!.standardizedFileURL

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
        "json": "application/json", "mp3": "audio/mpeg", "wav": "audio/wav", "woff2": "font/woff2",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/dune.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            let missing = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(missing)
            task.didReceive(Data())
            task.didFinish()
            return
        }
        let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"])!
        task.didReceive(ok)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// A Swift string as a JavaScript string literal.
private func jsString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    let array = String(data: data, encoding: .utf8)!
    return String(array.dropFirst().dropLast())
}
