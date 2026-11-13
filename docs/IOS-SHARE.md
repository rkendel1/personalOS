# Share to PersonalOS from iOS

In Safari, or any app with a Share button, tap **Share**, then **PersonalOS**. Add what you want done,
for example "Research this company and tell me whether it could be a customer for FeltKit", then tap
**Send**. PersonalOS confirms it has it, and you can close the share sheet. The work happens in
PersonalOS, and the result appears in the PersonalOS app, the conversation, Research and your inbox.

The extension submits intent; PersonalOS owns execution. Its contract is
[`personalos.invocation/1`](INVOCATION-CONTRACT.md).

## Status, plainly

| | State |
|---|---|
| Server side (contract, durable processing, AuthBoundry at execution, research from a shared page, return states) | Implemented. Tested in-process (`tests/invocations*.test.ts`, including against the real AuthBoundry) and over real HTTP with real accounts, the real AuthBoundry, a SIGKILL restart, the real web and a real model (`e2e/share-invocation.mjs`). |
| iOS app + share extension (`ios/`, SwiftUI, XcodeGen) | Written. **Not yet compiled or run**: it was written in a Linux container with no Xcode. Reviewed by hand for Swift and iOS API correctness. Two compile errors were found that way and fixed; others may remain. |
| Real iPhone acceptance | **Not yet performed.** It needs your Mac and iPhone; the procedure is below. |

## What's in `ios/`

| Path | What |
|---|---|
| `project.yml` | XcodeGen spec: the app `PersonalOS` and the extension `PersonalOSShare` (`com.apple.share-services`), iOS 16+ |
| `Config.xcconfig` | **Edit this:** your `DEVELOPMENT_TEAM` and `PERSONALOS_BUNDLE_PREFIX` |
| `Shared/` | The contract types, the HTTP client (FeltKit API, bearer session) and the Keychain store, used by both targets |
| `App/` | Sign in to your PersonalOS; the list of what you shared, with its state; open each in PersonalOS; sign out |
| `ShareExtension/` | Reads what was shared, takes an optional instruction, submits, and confirms. `Preprocess.js` runs in Safari for the page's address, title and selected text. |

Design points:

- **Credentials.** The extension holds no API key. The app signs in with your PersonalOS account
  (FeltKit's `POST /api/auth/signin`) and keeps that session in a Keychain access group shared only with
  its own extension (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). Signing out ends the session in
  PersonalOS, so the extension's next share is refused. A session ends after 7 days, and then you sign in
  again.
- **Retries.** Each share gets one `invocationId`, and a retry resends it, so a share is never received
  twice. A `CONFLICT` (409) answer is retried with the same id.
- **Unsupported content** is refused in the extension, and again by the server. That covers PDFs, images
  and files over 256 KB. Text documents are accepted.
- **No waiting.** The extension never waits for the work. It shows the receipt ("PersonalOS has it… You
  can close this") and closes.

## Requirements

| Need | Why |
|---|---|
| A Mac with Xcode 15 or later, and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) | to generate the project and build both targets |
| An Apple ID in Xcode (Settings → Accounts) | signing. A free **Personal Team** can install on your own iPhone, but its provisioning lasts 7 days, after which you rebuild. TestFlight or App Store distribution needs the Apple Developer Program. |
| Your iPhone on iOS 16 or later, with **Developer Mode** on (Settings → Privacy & Security), trusted by the Mac | running a development-signed app |
| Keychain Sharing capability (the entitlement is in `App/` and `ShareExtension/`) | the app and the extension share the session. If Xcode won't grant it to your team, signing in won't reach the extension, and the extension will say "Sign in first". |
| A PersonalOS the phone can reach | on your Wi-Fi: `scripts/share-acceptance.mjs` runs one on your Mac (`--host 0.0.0.0`; plain HTTP is allowed only to local addresses: `NSAllowsLocalNetworking`). Anywhere else needs an HTTPS deployment, which this change does not create. |
| AuthBoundry, and your delegation to `agent:personalos` | every share is authorized when it runs, with no exceptions: without a delegation it fails `FORBIDDEN`, and with no AuthBoundry `UNAVAILABLE`. The acceptance script sets up the real server and a delegation for you. |
| Optional: `AI_GATEWAY_API_KEY` on the Mac | a model for planning and assessment (gpt-4.1-mini via Vercel AI Gateway). Without it, the rules assess by keyword match and say so. |

## Build and install

```bash
cd ios
```

```bash
brew install xcodegen
```

Edit `Config.xcconfig` (`DEVELOPMENT_TEAM`, `PERSONALOS_BUNDLE_PREFIX`), then:

```bash
xcodegen generate && open PersonalOS.xcodeproj
```

In Xcode:

1. Select the **PersonalOS** scheme and your iPhone, then Run.
2. If iOS asks, trust the developer in Settings → General → VPN & Device Management.
3. The first time you share, tap **More** at the end of the app row in the share sheet, and turn on
   **PersonalOS**.

## Acceptance on a real iPhone

On the Mac, from the repository (with `npm ci` and `npm ci --prefix tests/authboundry` done):

```bash
AI_GATEWAY_API_KEY=… node --import tsx scripts/share-acceptance.mjs --out acceptance
```

It prints the address, email and password to use. On the iPhone, on the same Wi-Fi:

1. Open **PersonalOS**, sign in with what the script printed, and allow local network access.
2. In Safari, open a company's website.
3. Tap **Share**, then **PersonalOS**.
4. Enter: *Research this company and tell me whether it could be a customer for FeltKit.* Tap **Send**.
   Check that the share sheet says **PersonalOS has it**, then tap **Done**.
5. Close Safari, and lock the phone if you like.
6. Watch the Mac's terminal. The share arrives as `ios-share`, then moves to `processing`, then to
   `completed` (or `failed`, with the reason).
7. Open the PersonalOS app. The share is listed with its state. Tap it to open the result in PersonalOS:
   the verdict, the pages read, and the quotes with their links.
8. Ctrl-C the script. `acceptance/share-acceptance.json` is the evidence: the device's envelope
   (adapter, device, submission time), AuthBoundry's decision, the research steps, pages and quotes.

Also worth checking on the device:

| Check | Steps | Expected |
|---|---|---|
| Duplicate send | send, toggle airplane mode while it sends, then retry | one invocation |
| Unsupported file | share a PDF from Files | "Can't share this yet" |
| Sign-out | sign out in the app, then share | "Sign in first" |
| Revoked delegation | revoke `iphone-acceptance` in AuthBoundry, then share again | `failed: FORBIDDEN` |
