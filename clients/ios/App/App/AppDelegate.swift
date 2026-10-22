import UIKit
import Capacitor

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Categories persist across launches, so remote pushes can show the
        // action after the first open even when JS has not yet registered.
        NotificationCategories.register()

        // A cold-launch URL no longer rides `launchOptions` — under the scene
        // lifecycle the scene delegate forwards it from
        // `scene(_:willConnectTo:)`'s connection options to
        // `handleColdLaunchURLContexts`.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {
        // Launch-URL dedupe is scoped to the launch. Re-opening the identical
        // URL later requires leaving this app first, so anything arriving after
        // a background transition is a genuinely new open, never the launch
        // URL arriving twice.
        launchURL = nil
        launchURLWasReplayed = false
    }
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    /// A backgrounded voice session keeps the app alive (the `audio` background
    /// mode), so swiping it away in the app switcher terminates a *running*
    /// process and lands here. Its Live Activity outlives the process unless it
    /// is ended, which would strand an island the user cannot dismiss.
    func applicationWillTerminate(_ application: UIApplication) {
        VoiceLiveActivityPlugin.endRunningActivityBeforeTermination()
    }

    /// The cold-launch entry point for custom-scheme URLs: the scene delegate
    /// forwards `scene(_:willConnectTo:)`'s connection options here — the
    /// scene-lifecycle home of what `launchOptions[.url]` used to deliver. A
    /// QR scan that launches the terminated app brings its connect URL
    /// through this path.
    ///
    /// A launch URL came from outside the process, so it may not carry the
    /// in-process provenance marker; strip before storing so the dedupe below
    /// compares like with like, and drop a URL that cannot be stripped. See
    /// `CommandURLProvenance`.
    func handleColdLaunchURLContexts(_ urlContexts: Set<UIOpenURLContext>) {
        for context in urlContexts {
            guard let url = CommandURLProvenance.stripped(context.url) else {
                continue
            }
            if handleConnectDeepLink(url) {
                continue
            }
            // Every *other* custom-scheme launch URL (a `voice` or `thread`
            // link from the Live Activity or Safari; App Intents never arrive
            // this way, they run in-process) is stashed as a *backstop*, not
            // as the delivery. See `launchURL` for why it is both kept and
            // deduped.
            launchURL = url
            pendingCommandURL = url
            deliverExternalURL(url)
        }
    }

    /// A warm open from outside the process, forwarded from the scene
    /// delegate's `scene(_:openURLContexts:)`.
    func handleOpenURLContexts(_ urlContexts: Set<UIOpenURLContext>) {
        for context in urlContexts {
            guard let url = CommandURLProvenance.stripped(context.url) else {
                continue
            }
            deliverExternalURL(url)
        }
    }

    /// The tail both external paths share: this is where an external open
    /// loses any claim to intent provenance (already stripped above), a
    /// `connect` link routes to the pending confirmation, and everything else
    /// either dies in the launch-URL dedupe or reaches the web layer through
    /// Capacitor's proxy. Capacitor's `appUrlOpen` payload carries only the
    /// URL, so the launch-context options a warm open used to forward are not
    /// missed.
    private func deliverExternalURL(_ url: URL) {
        if handleConnectDeepLink(url) {
            return
        }
        if swallowIfLaunchURLAlreadyDelivered(url) {
            return
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    /// Universal Links, forwarded from the scene delegate's
    /// `scene(_:continueUserActivity:)` (and a cold launch's connection
    /// options, both under the scene lifecycle). Navigate the Capacitor
    /// webview to the incoming URL so that deep links (e.g. ?app=X#/pr/...)
    /// open in-app instead of Safari.
    func handleUserActivity(_ userActivity: NSUserActivity) {
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL {
            navigateWebView(to: url)
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in [] })
    }

    // MARK: - APNs Token Forwarding

    func application(
      _ application: UIApplication,
      didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
      NotificationCenter.default.post(
        name: .capacitorDidRegisterForRemoteNotifications,
        object: deviceToken
      )
    }

    func application(
      _ application: UIApplication,
      didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
      NotificationCenter.default.post(
        name: .capacitorDidFailToRegisterForRemoteNotifications,
        object: error
      )
    }

    // MARK: - Self-hosted connect deep link

    /// A parsed connect deep link waiting for explicit confirmation, then for
    /// the bridge web view to come up.
    private var pendingConnect: (base: URL, pairURL: URL, name: String?)?
    private var connectConfirmAlert: UIAlertController?

    /// Handle `<scheme>://connect?url=<https-base>&code=<device-code>` (with an
    /// optional `name=<label>`), the custom-scheme QR path that pairs the shell
    /// to a self-hosted assistant. The `url` parameter is the server base (host,
    /// optionally with a path prefix like `/assistant-123` for Tunnel-style
    /// hosting); it is both persisted and the value the pair-page URL is derived
    /// from, so there is one source of truth.
    ///
    /// One handler serves both entry points: a warm open via the scene's
    /// `scene(_:openURLContexts:)` and a cold launch via
    /// `scene(_:willConnectTo:)`'s connection options, both forwarded by the
    /// scene delegate. The
    /// `connect` host distinguishes it from the OAuth-completion deep link (host
    /// `oauth-complete`), which Capacitor's `appUrlOpen` routes.
    ///
    /// The link is parsed into pending in-memory state only. Persistence and
    /// pair-page navigation wait on an explicit Connect confirmation so a
    /// hostile QR or custom-scheme open cannot silently retarget the shell.
    /// Returns `true` for any `connect` link (handled or ignored) so it isn't
    /// also routed to the OAuth handler; `false` for everything else.
    private func handleConnectDeepLink(_ url: URL) -> Bool {
        guard url.host?.lowercased() == "connect" else {
            return false
        }
        guard let connect = AppDelegate.parseConnectDeepLink(url) else {
            NSLog("[connect] Ignoring malformed connect deep link")
            return true
        }

        pendingConnect = connect
        deliverPendingConnectNavigation()
        return true
    }

    /// Show connect confirmation once a presenter exists, then load the pair
    /// page after Connect. Safe to call before the view controller is created
    /// (a cold launch defers to the first `viewDidAppear`).
    func deliverPendingConnectNavigation() {
        guard let connect = pendingConnect,
              let presenter = currentBridgeViewController(),
              presenter.webView != nil
        else {
            return
        }
        if connectConfirmAlert != nil {
            return
        }
        let host = connect.base.host ?? connect.base.absoluteString
        let scheme = connect.base.scheme ?? "https"
        let alert = UIAlertController(
            title: "Connect to this assistant?",
            message: "\(scheme)://\(host) will become this app's server. Nothing is saved until you confirm.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self else { return }
            self.connectConfirmAlert = nil
            self.pendingConnect = nil
        })
        alert.addAction(UIAlertAction(title: "Connect", style: .default) { [weak self] _ in
            guard let self else { return }
            self.connectConfirmAlert = nil
            self.finishConfirmedConnect()
        })
        connectConfirmAlert = alert
        presenter.present(alert, animated: true)
    }

    private func finishConfirmedConnect() {
        guard let connect = pendingConnect else {
            return
        }
        guard let bridgeVC = currentBridgeViewController(),
              let webView = bridgeVC.webView
        else {
            return
        }
        SelfHostedServer.store(connect.base)
        SelfHostedServer.append(url: connect.base, name: connect.name)
        pendingConnect = nil
        (bridgeVC as? MyViewController)?.bindServerTrackingToConfiguredOrigin()
        webView.load(URLRequest(url: connect.pairURL))
    }

    /// Parse `<scheme>://connect?url=&code=` into the validated https server
    /// base, the pair-page URL to load, and the optional `name` label for the
    /// remembered-server list. Returns `nil` for a malformed or non-https link.
    ///
    /// `name` alone tolerates form encoding: a raw `+` (a space from a sender
    /// that form-encoded the query) decodes to a space, while an encoded
    /// `%2B` stays a literal plus. `url` and `code` are machine-generated and
    /// never form-encoded, so they take the strict percent decode.
    private static func parseConnectDeepLink(_ url: URL) -> (base: URL, pairURL: URL, name: String?)? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let serverParam = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty,
              let base = SelfHostedServer.validate(serverParam),
              let pairURL = pairPageURL(forBase: base, deviceCode: code)
        else {
            return nil
        }
        let name = components.percentEncodedQueryItems?
            .first(where: { $0.name == "name" })?.value?
            .replacingOccurrences(of: "+", with: "%20")
            .removingPercentEncoding
        return (base, pairURL, name)
    }

    /// Build the standalone SPA pairing route that completes the pre-approved
    /// device-code exchange, `<base>/assistant/pair#device_code=<code>`.
    ///
    /// `/assistant/pair` is appended to the base's existing path so a hosting
    /// prefix survives (base `https://host/assistant-123` →
    /// `https://host/assistant-123/assistant/pair`); `appendingPathComponent`
    /// also normalizes a trailing slash on the base.
    private static func pairPageURL(forBase base: URL, deviceCode: String) -> URL? {
        let pairBase = base.appendingPathComponent("assistant").appendingPathComponent("pair")
        guard var components = URLComponents(url: pairBase, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.query = nil
        let encodedCode = deviceCode.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? deviceCode
        components.percentEncodedFragment = "device_code=\(encodedCode)"
        return components.url
    }

    // MARK: - Command deep links

    /// A `<scheme>://voice?mode=…` or `<scheme>://thread/…` command (or any
    /// other non-`connect` launch URL) waiting for the bridge web view to
    /// come up, mirroring `pendingConnect` above. Only the most recent
    /// one is kept: a superseded command is stale by definition.
    private var pendingCommandURL: URL?

    /// The URL this process was launched with, while it is still eligible to
    /// arrive a second time through the scene's open-URL path.
    ///
    /// Under the scene lifecycle a cold-launch URL is delivered exactly once:
    /// the scene delegate forwards `scene(_:willConnectTo:)`'s connection
    /// options to `handleColdLaunchURLContexts`, which stashes it here and then
    /// attempts the same delivery a warm open would make. That attempt races
    /// the bridge: `ApplicationDelegateProxy` delivers by posting
    /// `.capacitorOpenURL`, and `AppPlugin` only subscribes in its `load()`, so
    /// a URL that arrives before the bridge finishes registering plugins (its
    /// synchronous `viewDidLoad`, which the key window's first appearance
    /// triggers) has no observer and is dropped. Nothing in the web layer calls
    /// `App.getLaunchUrl()`, Capacitor's usual escape hatch for exactly that.
    ///
    /// So: the immediate forward is the delivery when the bridge is already
    /// up, the stash is the backstop when it is not, and this holds the
    /// identity that lets whichever one loses the race stay silent.
    private var launchURL: URL?

    /// Whether the backstop replayed `launchURL` already, so an open-URL
    /// delivery of the same URL that follows is recognized as the same payload
    /// rather than a fresh one.
    private var launchURLWasReplayed = false

    /// Reconcile an open-URL delivery against the launch URL, answering
    /// whether it is a second delivery of something the web layer already has
    /// and should be dropped here.
    ///
    /// Three cases, and only the launch URL reaches any of them:
    ///
    /// 1. The backstop already replayed it — swallow, the web layer has it.
    /// 2. The bridge is up, so this forward will be observed. Drop the backstop
    ///    and deliver here.
    /// 3. The bridge is not up yet: `ApplicationDelegateProxy` posts
    ///    `.capacitorOpenURL` to an `AppPlugin` that has not subscribed, so this
    ///    forward goes nowhere. Keep the backstop — it is the only delivery
    ///    left. The forward still happens, harmlessly, and sets the proxy's
    ///    `lastURL` for `App.getLaunchUrl()`.
    ///
    /// The bridge check is `webView != nil`, which is exactly what the replay
    /// waits for: `CAPBridgeViewController` builds the web view and registers
    /// plugins in one synchronous `viewDidLoad`, so from the outside the two are
    /// the same fact.
    private func swallowIfLaunchURLAlreadyDelivered(_ url: URL) -> Bool {
        guard url == launchURL else { return false }
        if launchURLWasReplayed {
            launchURL = nil
            launchURLWasReplayed = false
            return true
        }
        guard currentBridgeViewController()?.webView != nil else {
            return false
        }
        launchURL = nil
        pendingCommandURL = nil
        return false
    }

    /// Hand a command URL to the web layer, deferring until the bridge web
    /// view exists.
    ///
    /// Called only by the App Intents (the voice intents via
    /// `VoiceModeDeepLink.route()`, `SendMessageToChatIntent` via
    /// `ThreadDeepLink.route()`, and `OpenCameraIntent` / `OpenNewChatIntent`
    /// via `CommandDeepLink.route(host:)`), which run in-process and therefore
    /// never arrive through the scene's open-URL paths. A widget tap is no
    /// exception:
    /// those intents declare `openAppWhenRun`, so the system performs them in
    /// the app process rather than in the appex. That exclusivity is
    /// load-bearing: it is what lets this method vouch for the URL by adding
    /// the provenance marker the external entry points strip (see
    /// `CommandURLProvenance`).
    /// Do not route anything that arrived from outside the process through
    /// here; the terminated-launch path in `handleColdLaunchURLContexts`
    /// deliberately stashes into `pendingCommandURL` directly instead.
    func deliverCommandURL(_ url: URL) {
        pendingCommandURL = CommandURLProvenance.marked(url)
        deliverPendingCommandURL()
    }

    /// Replay a stashed command once the bridge web view is live. Safe to
    /// call before the view controller exists (a cold launch defers to the first
    /// `viewDidAppear`) and idempotent once delivered.
    ///
    /// Delivery goes through `ApplicationDelegateProxy`, the exact channel the
    /// scene delegate's URL forwarding uses, so the URL surfaces to JS as
    /// Capacitor's
    /// `appUrlOpen` and `capacitor-deep-links.ts` handles it with no new web
    /// code. `AppPlugin` posts that event with `retainUntilConsumed: true`, so a
    /// command delivered before the SPA has registered its listener is replayed
    /// rather than lost.
    ///
    /// Exactly one delivery of a launch URL, whichever route wins the race —
    /// see ``launchURL``.
    func deliverPendingCommandURL() {
        guard let url = pendingCommandURL,
              currentBridgeViewController()?.webView != nil
        else {
            return
        }
        pendingCommandURL = nil
        if url == launchURL {
            launchURLWasReplayed = true
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: url,
            options: [:]
        )
    }

    // MARK: - Web view navigation

    /// The Capacitor bridge view controller — the key window's root, or
    /// embedded in a navigation controller, or a direct child of the root.
    /// The window lives on the scene delegate under the scene lifecycle, so
    /// it is looked up through the connected scene, the same read-only
    /// pattern `NativeAuthPlugin` uses.
    private func currentBridgeViewController() -> CAPBridgeViewController? {
        let keyWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow })
        guard let rootVC = keyWindow?.rootViewController else { return nil }
        if let bridgeVC = rootVC as? CAPBridgeViewController {
            return bridgeVC
        }
        if let nav = rootVC as? UINavigationController,
           let bridgeVC = nav.viewControllers.first as? CAPBridgeViewController {
            return bridgeVC
        }
        return rootVC.children.compactMap { $0 as? CAPBridgeViewController }.first
    }

    /// Navigate the bridge's WKWebView to the given URL.
    private func navigateWebView(to url: URL) {
        currentBridgeViewController()?.webView?.load(URLRequest(url: url))
    }
}
