import Foundation

/// Pure parser for the baked native config: extracts the synced
/// `capacitor.config.json`'s `plugins.CadetCloud.cloudUrl` — the
/// environment's control-plane base, resolved at sync time from
/// `CADET_ENVIRONMENT` (per-environment cloud web origins; `local` dials
/// the control-plane default). `cap sync` bakes the document into the
/// bundle, making it — not the boot bundle, which the build no longer
/// stamps — the build's source of truth for the baked default.
/// Lives outside `SelfHostedServer` so the host-less `AppTests` bundle can
/// compile it directly (the `AvatarCache` / `SenderPayload` pattern).
/// `nil` when the config is absent or unreadable.
enum BakedCloudConfig {
    static func parse(_ config: Data) -> URL? {
        guard
            let object = (try? JSONSerialization.jsonObject(with: config))
                as? [String: Any],
            let plugins = object["plugins"] as? [String: Any],
            let cadetCloud = plugins["CadetCloud"] as? [String: Any],
            let baked = cadetCloud["cloudUrl"] as? String,
            let url = URL(string: baked)
        else {
            return nil
        }
        return url
    }
}
