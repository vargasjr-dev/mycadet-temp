# Cadet iOS app

Native iOS wrapper built with [Capacitor](https://capacitorjs.com/): a thin
`WKWebView` shell in `server.url` mode that loads the live web app over
HTTPS. This doc covers installing the app; the release tooling lives in
`.github/workflows/release-ios.yaml` and the native-voice contract in
[`docs/NATIVE_VOICE.md`](docs/NATIVE_VOICE.md).

Signing is owned by the **Vargas JR LLC** Apple Developer team
(`R4U5NUZX29`). The team's certificates, provisioning profiles, and App
Store Connect API key are wired into CI as repo secrets — you never need
an Apple account of your own to release or to install.

## Install the app

### Dev channel — TestFlight

Every merge to `main` runs the **Dev Release** workflow, which archives
the app and uploads it to TestFlight automatically. To get on it:

1. Install Apple's **TestFlight** app from the App Store.
2. Get added as a tester for the **MyCadet Dev Mobile App** (bundle
   `ai.mycadet.ios.dev`) — ask David for the invite. <!-- TODO: replace with the public TestFlight invite link once one exists -->
3. Open the invite in TestFlight and install. Dev builds are
   internal-testing builds: they **expire after 90 days**, and a new
   merge to `main` supersedes them — update through TestFlight.

### Production

Ships via the App Store. <!-- TODO: App Store link once live -->

## How a release works

Push to `main` → `dev-release.yaml` → `release-ios.yaml`: bump the
version, generate the Xcode project with XcodeGen, archive with manual
signing from the repo secrets, export the `.ipa`, validate and upload to
TestFlight (App Store Connect API key). Pull requests touching
`clients/ios/**` run the build-only `pr-ios.yaml` lane with the same
toolchain. A failed mobile leg never reds the release — it's a tolerated
canary.
