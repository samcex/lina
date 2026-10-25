# LINA for Android

LINA is a native Android client for your host's LINA daemon. Conversations, the
composer, project/session selection, live agent activity, file picker, controls,
changes/undo, file inspection/search, findings, previews and model settings use Android Views and the REST
API directly. They work without JavaScript or an up-to-date WebView. An optional
**Menu → Open web interface** screen exposes the existing web UI separately.

Install [lina.apk](https://github.com/samcex/lina/releases/latest/download/lina.apk) on Android 8 or newer. Updates retain your connection
and drafts when signed with the same local signing key.

## Connect

**Tailscale (no SSH tunnel or token):** on the host run `lina tailscale on`.
Connect Tailscale on the phone, then paste the printed HTTPS address into
**LINA → Menu → Connection**. LINA signs in using the Tailscale account allowed by
the host. The host's daemon must support Tailscale socket authentication.

**SSH tunnel:** keep a tunnel running on the phone, for example in Termux:

```sh
ssh -N -L 7077:127.0.0.1:7077 user@host
```

Replace **both** port numbers when the daemon uses another port. Run
`lina ui --url` on the host and paste its entire URL, including `#token=…`, into
Connection. Alternatively enter the localhost address and token separately.
The APK's login storage is separate from Chrome and the PWA.

**Home Wi-Fi with Tailscale off:** enable `lina home on` on the PC (use
`--host 192.168.x.x` if it has several physical LAN addresses). Open the app through
Tailscale once. It privately saves the verified home address, certificate fingerprint,
server identity and a durable home-only credential. On home Wi-Fi it connects directly
over pinned HTTPS; away it uses the saved Tailscale address. Network changes and foreground
relaunches trigger detection automatically. No address editing, SSID/location permission
or SSH tunnel is needed. Conversations, drafts and pending attachments stay on the same
server. Writes are never automatically replayed during a switch.

Tap the connection label or **Menu → Connection** to see pairing readiness or retry.
`lina home off` stops home access immediately; it does not stop Tailscale or the daemon.
Home pairing survives daemon restarts. If the PC's LAN address changes, enable home access
on its new address and open the app through Tailscale once to refresh the saved route.

Manual connection accepts only explicit `http://127.0.0.1:PORT/`, `http://localhost:PORT/` and
`https://MACHINE.TAILNET.ts.net[:PORT]/` origins. Authenticated pairing additionally accepts
an HTTPS private IPv4 origin with its exact certificate pin. API requests cannot
redirect credentials to another origin. Loopback cleartext traffic stays inside
the phone's tunnel; Tailscale uses HTTPS with normal certificate validation.

Credentials and drafts are saved in the app's private storage with Android backup
and debugging disabled. The daemon token grants full host control: use
**Connection → Forget device** on a shared phone. This clears native credentials,
drafts, attachments, both paired routes and web-login storage. It does not revoke copies of the host
token elsewhere. After a host restart changes a loopback token, paste the current
URL again; reconnecting to the same origin preserves the current message and files.
Changing hosts warns before discarding an unsent draft.

## Use

The home screen searches conversation titles and filters **All**, **Active** or
**Needs you**. **New chat** starts a conversation; projects and host settings are
in the top-right menu. Conversation rows show their latest status and update time.
Inside a chat, the back arrow returns to the list, with confirmation for an unsent
draft. **Activity**, **Changes** and **Files** are directly above the transcript;
the menu provides the remaining tools. Messages format headings, bold text and code
while staying selectable. The composer has attachment and Send icons; Send becomes
available when a message or attachment is ready.

- **New conversation** selects a registered host project. **Add project** accepts
  an absolute path on the host and explicitly offers directory/Git initialization.
- New-session options expose all six modes, developer, custom planner/reviewers,
  direct/isolated workspaces, conversational/structured interaction, review rounds,
  test command and restricted-mode network setting. Project defaults are inherited.
  Parallel/compete require isolation; isolated sessions use structured workflows.
- Send messages and attach files with the native document picker (maximum 20 MB
  per file). Send waits for upload completion. Attachments and drafts survive
  normal relaunches and rotation. Tap the attachment count to remove a pending file.
- **Agent activity** shows live status, streaming text, latest responses and
  observed/narrated actions. Filter All agents/Codex/Claude while the dialog stays
  open. The client polls incrementally every 1.5 seconds while foregrounded, stops
  polling in the background and reconnects automatically after transport outages.
  Load earlier messages accesses history beyond the initial 2,000-event window;
  search jumps to older matching messages without discarding current live state.
- **Session controls** provides pause/resume/cancel/retry/review and isolated-result
  approval/rejection/candidate selection when appropriate. **Candidate comparison**
  shows measured tests, findings, diff size and usage; candidate patches are in
  **Changes and undo**. Approval actions confirm before applying host changes.
- **Changes and undo** inspects current/individual-turn diffs and safely requests a
  turn undo. **Findings** exposes details and recorded human waivers.
- **Previews** starts a foreground command on the host, shows its URL/logs and stops
  it explicitly. Phone access to the preview URL needs its own SSH port forwarding;
  forwarding the daemon alone does not expose preview ports.
- **Models and mode** offers provider catalogues, custom model IDs, live validation,
  per-agent effort and interaction settings. **Settings** changes developer access.
  Validation uses the actual provider CLI and may consume provider usage.

The optional web interface requires a compatible Android System WebView; older
WebViews display an update message. Its connection/login storage is isolated from
the primary native connection. Native chat remains usable on those older devices.

## Build and verify

Use JDK 17+ and Android SDK platform 36/build-tools 36.0.0:

```sh
ANDROID_HOME="$HOME/Android/Sdk" npm run build:android
npm test -- --maxWorkers=2 test/android
```

The SDK's `aapt2`, `d8`, `zipalign` and `apksigner` produce and verify
`dist/android/lina.apk`, copy it to the root, `web/public/lina.apk` and an existing `dist/web/lina.apk`, and require
no Gradle/Maven downloads or third-party runtime libraries. `npm run build:web`
includes that APK in `dist/web/lina.apk`. The daemon serves APKs with no-store
headers and the service worker does not cache them.

The build creates a private signing key in `android/.local/lina.keystore`, ignored
by Git, with directory mode 0700 and key mode 0600. Keep that key to sign future
updates. A different key requires uninstalling the previous APK, clearing its data.
An existing keystore can be selected using `LINA_ANDROID_KEYSTORE` (alias `lina`)
and `LINA_ANDROID_STORE_PASSWORD` (default `android`). Symlink keys/directories and
unowned/non-private custom key directories are rejected. Never distribute the key.

Plain JVM tests exercise the URL policy and real loopback HTTP transport (auth,
errors, raw upload bytes, response limits, redirects and mutation non-replay).
Signing-script tests verify private keys and readable APK distribution.

For actual UI/runtime verification, boot a **disposable test emulator**, build the
APK and run:

```sh
python3 scripts/verify-android.py --serial emulator-5562 --extended \
  --output /tmp/lina-native-verification
```

This deliberately resets only LINA's data on the explicitly selected emulator;
physical-device serials are refused. It runs its own temporary daemon/project with
scripted agents and never uses the owner's LINA_HOME or sessions. It checks actual
native flows and host file changes, writes screenshots, crash logs, incremental
`checks.json` and final `result.json`, and removes its reverse-port mapping and
temporary daemon afterward. The extended run performs actual work in every mode,
control recovery, candidate selection, approval, settings and finding waivers.
It requires a document picker; the script supports both AOSP and Google images.
Real-provider and real-Tailscale smoke checks are separate from this deterministic
suite and must be reported independently.
Use `--recovery-only` for a focused login/outage/draft/Forget rerun after unrelated
native flows have already passed on the same APK.

For automatic routing, with a physical LAN address and an unused temporary Tailscale
HTTPS port, run `python3 scripts/verify-android-routes.py --serial emulator-5564
--home-ip 192.168.1.100 --tailnet-port 37444 --output /tmp/lina-routes`. This uses its
own temporary daemon/project and removes only its own temporary Tailscale proxy.
It checks real authenticated Tailscale and pinned home TLS, Wi-Fi changes, cold
relaunch without the Tailscale route, daemon token rotation, draft/session retention,
optional web rendering, Forget and the exact installed APK hash.
