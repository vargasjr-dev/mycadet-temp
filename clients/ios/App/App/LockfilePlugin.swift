import Capacitor
import Darwin
import Foundation

/// Reads the Cadet CLI's lockfile off the host machine and hands the raw JSON
/// text across the bridge. The baked web bundle's local-mode seam
/// (`clients/web/src/runtime/local-mode-host.ts`) parses it and strips the
/// sensitive fields web-side — the same `stripSensitiveFields` the dev-server
/// host runs — so this plugin deliberately ships the file's bytes rather than
/// parsed, redacted data: one sanitizer, identical wire shape on every host.
///
/// Candidate paths mirror the CLI's own resolution: the `CADET_LOCKFILE_DIR`
/// override, then the XDG config dirs (`cadet`, `cadet-local`, `cadet-dev` —
/// production first, since the plain `cadet` install is the one a simulator
/// QA run shares its assistants with). The first readable file wins.
///
/// A simulator build runs as the Mac user, so `getpwuid` resolves the real
/// home directory and the CLI's actual lockfile is readable here. A device
/// build has no such file; the plugin rejects and the web layer falls back to
/// its persisted mirror / empty-lockfile state, exactly as it does when no
/// dev-server host is reachable.
@objc(LockfilePlugin)
public class LockfilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LockfilePlugin"
    public let jsName = "LockfilePlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readLockfile", returnType: CAPPluginReturnPromise),
    ]

    private static let lockfileDirOverride = "CADET_LOCKFILE_DIR"
    private static let environmentOverride = "CADET_ENVIRONMENT"
    private static let environmentSuffixes = ["", "-local", "-dev"]

    @objc public func readLockfile(_ call: CAPPluginCall) {
        guard let text = Self.readFirstLockfile() else {
            call.reject("No Cadet lockfile was found on this machine.")
            return
        }
        call.resolve(["lockfile": text])
    }

    /// The first readable candidate lockfile, or nil when none exists.
    static func readFirstLockfile() -> String? {
        for candidate in candidateLockfilePaths() {
            if let text = try? String(contentsOfFile: candidate, encoding: .utf8) {
                return text
            }
        }
        return nil
    }

    /// Candidate lockfile paths in read order: the explicit dir override (the
    /// CLI's own escape hatch, honored when the launch environment carries
    /// it), then each environment's XDG config dir.
    static func candidateLockfilePaths(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: String? = macHomeDirectory()
    ) -> [String] {
        var candidates: [String] = []
        if let override = environment[Self.lockfileDirOverride], !override.isEmpty {
            candidates.append(override + "/lockfile.json")
        }
        guard let home, !home.isEmpty else {
            return candidates
        }
        for suffix in Self.environmentSuffixes {
            candidates.append(home + "/.config/cadet" + suffix + "/lockfile.json")
        }
        return candidates
    }

    /// The home directory of the user this process runs as — on the simulator
    /// that is the Mac user (whose `~/.config/cadet*` the CLI writes); an app
    /// container on a device resolves to the sandbox home, where no lockfile
    /// exists and the rejection above is the honest answer.
    private static func macHomeDirectory() -> String? {
        guard let passwd = getpwuid(getuid()), let dir = passwd.pointee.pw_dir else {
            return nil
        }
        return String(cString: dir)
    }
}
