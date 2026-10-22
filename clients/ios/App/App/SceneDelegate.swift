import UIKit

/// The scene delegate for the app's single window scene (`Info.plist` declares
/// `UIApplicationSceneManifest` naming this class — the current SDK aborts at
/// launch without it).
///
/// The scene configuration points at `Main.storyboard`, so the window still
/// comes from the storyboard exactly as before: UIKit instantiates its single
/// `MyViewController` scene and hands the configured window to the `window`
/// property below. Nothing is created here — the delegate exists because
/// opens and activities now land on scenes, and every one of them is
/// forwarded to `AppDelegate`, which owns the deep-link policy (provenance
/// stripping, the connect confirmation, the dedupe/backstop machinery).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: Scene.ConnectionOptions) {
        // A terminated launch with a custom-scheme URL or a universal link
        // delivers them here, in the connection options — under the scene
        // lifecycle `launchOptions[.url]` is never populated and
        // `application(_:continue:)` is never called.
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        if !connectionOptions.urlContexts.isEmpty {
            appDelegate.handleColdLaunchURLContexts(connectionOptions.urlContexts)
        }
        for activity in connectionOptions.userActivities {
            appDelegate.handleUserActivity(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        (UIApplication.shared.delegate as? AppDelegate)?.handleOpenURLContexts(URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        (UIApplication.shared.delegate as? AppDelegate)?.handleUserActivity(userActivity)
    }
}
