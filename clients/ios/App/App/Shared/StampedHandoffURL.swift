import Foundation

/// Pure parser for the boot bundle's stamped config: extracts the inline
/// `window.__CADET_CONFIG__` payload's `cloudUrl` — the environment's
/// control-plane base (a tunnel URL, the app server's loopback port, or the
/// cloud web origin) — from the synced `public/index.html`.
/// `build:capacitor` stamps the config (escaping its `<`s, so splitting at
/// `</script>` is safe) and `cap sync` copies the document into the bundle,
/// making it — not the native config, which no longer carries a
/// `server.url` — the build's source of truth for the baked default.
/// Lives outside `SelfHostedServer` so the host-less `AppTests` bundle can
/// compile it directly (the `AvatarCache` / `SenderPayload` pattern).
/// `nil` when the stamp is absent or unreadable.
enum StampedHandoffURL {
    static func parse(_ html: String) -> URL? {
        guard
            let marker = html.range(of: "window.__CADET_CONFIG__="),
            let end = html[marker.upperBound...].range(of: "</script>")
        else {
            return nil
        }
        let payload = String(html[marker.upperBound..<end.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard payload.hasSuffix("}"),
              let data = payload.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let stamped = object["cloudUrl"] as? String,
              let url = URL(string: stamped)
        else {
            return nil
        }
        return url
    }
}
