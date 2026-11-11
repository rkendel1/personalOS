# PersonalOS for Chrome

The PersonalOS assistant in Chrome's side panel, beside whatever page you're on. It is the same app
as the web version (`src/App.tsx`), pointed at **your deployed instance** with a session you get by
signing in to your account. There is no second backend: the same conversations, tasks, reminders,
memory, files, notifications, model and approvals. A task you add from a page is on your phone too.

## What it adds to the web app

- **This page** bar: *Summarize*, *Ask about it* (your selection if you have one), *Save to Files*
  (the page text becomes a document with its address as the note), *Read later* (a task).
- **Right-click menu**: *Ask PersonalOS about "selection"*, *Add to my PersonalOS tasks*, *Save this page*.
- Nothing is read from a page until you press one of these (`activeTab`). The extension has no
  access to any site except your PersonalOS address, which Chrome asks you to allow when you connect.
- As everywhere in PersonalOS, the assistant only *proposes* changes; you approve them in the panel.

## 1. Deploy PersonalOS

The extension needs a reachable instance with HTTPS (plain `http://localhost` works for development).

```bash
npx feltkit readiness --env production     # what is still missing
npx feltkit deploy                         # container (default), fly, vercel, cloudflare, …; see .feltkit/deploy/DEPLOY.md
```

Then, once, on the deployed instance: set the model (Studio → Models, or the Resolver reference
`ref://prod/personalos/model`) and make sure people can sign up and sign in (`auth.accounts` in
`feltkit/app.ts`; for e-mail verification and password reset, configure mail). The extension does not
use `feltkit dev`'s development users in production: you sign in with your account.

## 2. Build and load

```bash
npm install
npm run extension:build      # writes extension/dist
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → choose `extension/dist`.
Click the toolbar icon to open the panel, enter your instance address, **Allow**, and sign in.

Signing out in the panel ends that session on the server. Each browser holds its own session, so you
can see and revoke it like any other device.

## Publishing

For the Chrome Web Store: zip `extension/dist`, replace `icons/icon.png` with 16/48/128 px artwork,
and list the permissions' reasons (`sidePanel`, `storage`, `activeTab`, `scripting`, `contextMenus`; hosts
are optional and requested per instance).

## Limits today

- Sign-in is e-mail and password. Provider buttons (Google, GitHub) redirect the page, which a side panel can't
  follow; they'd need `chrome.identity.launchWebAuthFlow`.
- The assistant sees the page text the extension sends in a message (up to about 2,800 characters). Saved
  pages are stored whole, but the assistant can list files, not read them (see the README's gaps).
- Reminders and the daily/weekly check-ins arrive as PersonalOS notifications in the app; there are no
  Chrome toast notifications yet.
