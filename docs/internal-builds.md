# Internal app builds

The team installs Mentosbot straight from GitHub; nothing goes to an app store. The
`build-apps` workflow builds:

- **macOS**: a universal `.dmg`, ad-hoc signed (no Apple Developer ID).
- **Windows**: an x64 `.exe` installer, unsigned.
- **Android**: an `arm64-v8a` APK that connects to `https://mentos.shimanto.xyz`.

iOS is not built yet.

## Build

- **Any time**: Actions → `build-apps` → Run workflow. The files are on the run page under
  Artifacts.
- **Release**: push a tag such as `app-v1.0.0`. The same files are attached to a GitHub release
  of that name. Plain `v*` tags are for server images, not apps.

```sh
git tag app-v1.0.0 && git push origin app-v1.0.0
```

No secrets are needed.

## Install

- **macOS**: open the `.dmg` and drag Mentosbot to Applications. The first launch is blocked
  because the app is not notarized: open System Settings → Privacy & Security and choose
  Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Mentosbot.app`.
- **Windows**: SmartScreen warns about an unknown publisher: More info → Run anyway.
- **Android**: open the APK on the phone and allow installing from that source. A newer APK
  installs over the old one.

## Updates

The apps do not update themselves. Install the new build over the old one.

## Notes

- The Android APK is signed with Expo's template debug key, which is public. That is fine for
  a team installing its own builds, but anyone could sign an APK with the same key, so only
  install APKs from this repository.
- Android push notifications need a Firebase `google-services.json`, which this build does not
  include.
