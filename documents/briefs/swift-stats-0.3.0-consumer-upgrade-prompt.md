Upgrade this app's swift-stats integration to 0.3.0 and check whether anything in the app has to change. Plan first, then make the changes, build, run the tests, and do not push.

Sources of truth (read before changing anything):
- The swift-stats CHANGELOG, section "[0.3.0] — Upgrade notes": https://github.com/awizemann/swift-stats/blob/main/CHANGELOG.md
- The agent setup guide: https://swiftstats.co/setup/v1.md (Install identity, §2 write key, §4 lifecycle, §7 privacy).
If the v0.3.0 tag doesn't resolve yet, stop and tell me; don't pin a branch or a commit.

1. Dependency. In Package.swift or the Xcode package settings, pin `.upToNextMinor(from: "0.3.0")` ("Up to Next Minor Version" in Xcode), not `from:`, because 0.x minor versions can break things. Resolve and build.

2. Find every swift-stats touchpoint: StatsConfiguration, StatsClient construction, setConsent, setEnabled, identify, reset, currentConsent, isEnabled, the lifecycle calls, flush, and any StatsTesting use. Then check each item below against the code and tell me which ones apply.

   a. Default consent now includes `.identity` (one stable id per install; per-user only through identify). If the app passes no consent or `.default`, install counts become real counts after the upgrade. On the dashboard that shows up as a drop in installs and a one-week spike of first-seen installs. Nothing in the code has to change, but say so in the release notes.
   b. If the app calls `setConsent(_:)` anywhere (for example a consent screen), the stored choice beats the configuration. If the stored value lacks `.identity` and the app wants install metrics, use the guide's one-time migration (case b). Add `.identity` to the app's own consent record first, then call setConsent(current ∪ .identity) once, behind a flag. Skip anyone who declined identity.
   c. `setConsent(.default)` now grants identity. Check whether any button or flow passes `.default` meaning "no identity". If one does, pass `[.usage, .diagnostics]` explicitly.
   d. `identify(userID:)`: under the old default it did nothing. From 0.3.0 a hashed userId is sent and persisted. If the app calls identify, decide whether that's wanted. If not, remove the call, or keep the user's consent at `[.usage, .diagnostics]`.
   e. One live client per app id. A second StatsClient for the same appId now forwards every call to the first. A client whose storageDirectory belongs to a different appId is refused. Make sure the app builds exactly one client and injects it (no per-window or per-screen clients, no global facade). Settings screens should use the shared one.
   f. `currentConsent`, `isEnabled` and `hasStableInstallIdentity` are now `get async`. Fix any call site that doesn't compile.
   g. While the person has opted out or consent is `.none`, `flush()`, `reset()` and `applicationDidEnterBackground()` no longer send a leftover queue; it's discarded. Check that no code depends on that old send.
   h. StatsTesting: `ManualClock.waitForSleepers(count:)` now waits and returns Void; the bounded form is `waitForSleepers(count:maxYields:)`. New in StatsTesting: `RelaunchProbe` and `InMemorySink.waitForBatches(_:)`.

3. Settings copy and the opt-out:
   - `setEnabled(_:)` is the user's on/off switch.
   - `setConsent` is only for a real consent change, never per launch.
   - Any settings copy about collection must match the guide's §7 table of what every batch sends: app version and build, OS version, device model, language and region, and so on. Never say "never your device".
   - Write "anonymous" only if the app does not call identify.

4. App Store privacy label and manifest:
   - The SDK manifest now declares Device ID (not linked, not tracking).
   - Make the app's label match: Product Interaction, Other Diagnostic Data, Device ID.
   - If identify is called, add User ID and mark every collected category Linked.
   - Report what you changed or what I need to change in App Store Connect.

5. Lifecycle (per the guide's §4):
   - applicationDidBecomeActive and applicationDidEnterBackground must be wired (scenePhase).
   - On macOS, also flush on resign-active and on terminate.
   - Menu-bar apps should call didBecomeActive when the popover opens; it's safe to call repeatedly within a session.
   - Don't record events from work that runs with nobody present (launch-at-login jobs, auto-sent reports). track() and record() start a session by themselves and make an idle Mac look in use.

6. Write key (per the guide's §2):
   - It comes from an xcconfig or CI secret, never from source.
   - In CI, pass APP_STATS_WRITE_KEY as an environment variable, not as a `KEY=value` argument to xcodebuild.
   - Make sure no xcconfig defines a placeholder that would override it.

7. Test. Add a test with StatsTesting's `RelaunchProbe.installIDsAcrossRelaunch(configuration:)` asserting the app's real configuration keeps one installId across a relaunch. If the app deliberately denies identity, assert the opposite. Run the full test suite and a build for every platform the app ships.

8. Report back:
   - which of 2a–2h applied and what you changed;
   - privacy-label changes I need to make;
   - anything you weren't sure about;
   - the test results.
   Commit with a clear message. Don't push.
