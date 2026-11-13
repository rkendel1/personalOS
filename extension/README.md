# PersonalOS for Chrome

The PersonalOS assistant in Chrome's side panel, beside whatever page you're on. It is the same app
as the web version (`src/App.tsx`), pointed at **your deployed instance** with a session you get by
signing in to your account. There is no second backend: the same conversations, tasks, reminders,
memory, files, notifications, model and approvals. A task you add from a page is on your phone too.

## What it adds to the web app

- **Summon PersonalOS** (the page bar, or right-click → *Summon PersonalOS with this…*): send this page
  (its address as Chrome reports it, and its title), the text you selected if you choose, and what you
  want done.
  - **It is an invocation**, not a chat message (`personalos.invocation/1`, adapter `browser`). PersonalOS
    takes who you are from the panel's session, checks your AuthBoundry delegation when the work runs,
    and does it in the background.
  - **You can close the page.** The panel shows the receipt and then the outcome, live. **Open
    conversation** shows the result with its evidence. **Back to the page** reopens the page.
  - **Continuing.** Summoning again from the same page continues that conversation.
  - **Untrusted page content.** What the page says is information for PersonalOS, never instructions.

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

## Why Summon is in the extension, not a bookmarklet

A bookmarklet was the lighter option, and it was rejected for three reasons:

- **No way to hand over the context.** FeltKit serves PersonalOS with
  `Cross-Origin-Opener-Policy: same-origin`, so a PersonalOS window a bookmarklet opens has no
  `window.opener`, and the page can't pass it anything with `postMessage`. The selected text would then
  have to travel in the PersonalOS address, where browser history keeps it, or through the clipboard.
- **A page can tamper with it.** A bookmarklet runs in the page's own JavaScript, so the page can replace
  `getSelection`, `window.open` or `location` before it runs.
- **The extension already avoids both.** It reads the page in an isolated world the page can't touch,
  takes the address from Chrome (`tab.url`), reads nothing until you act (`activeTab`), and keeps its
  session where no content script can reach it (tested in `e2e/extension.mjs`).

## Limits today

- Sign-in is e-mail and password. Provider buttons (Google, GitHub) redirect the page, which a side panel can't
  follow; they'd need `chrome.identity.launchWebAuthFlow`.
- *Summarize*, *Ask about it*, *Read later* and the right-click requests are invocations too: the
  page is context and the button or your question is the instruction. *Summarize* needs a model, and
  says so without one. See docs/CONTINUITY.md.
- The assistant sees the page text the extension sends in a message (up to about 2,800 characters). Saved
  pages are stored whole, but the assistant can list files, not read them (see the README's gaps).
- Reminders and the daily/weekly check-ins arrive as PersonalOS notifications in the app; there are no
  Chrome toast notifications yet.
