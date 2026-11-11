/**
 * Drives the running app in a real browser (Chromium via Playwright), through the UI only.
 *   node e2e/ui.mjs <url> <phase> [screenshotDir]
 * phase "before": DoD 1, 3, 5, 6, 7, 8, 9 (plus an approval). phase "after": run after the
 * server process was restarted; checks the same state is still there (DoD 2, 4).
 */
import { createRequire } from "node:module";
// The pre-installed Playwright (NODE_PATH=$(npm root -g)), or a local one.
const { chromium } = createRequire(import.meta.url)("playwright");
import assert from "node:assert/strict";

const [url = "http://localhost:5180", phase = "before", shots = "."] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const log = (...a) => console.log("✓", ...a);
const last = () => page.locator(".msg.assistant .bubble:not(.typing)").last();
async function say(text) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Send").click();
  // Done when the last message is an assistant reply that follows our message.
  await page.waitForFunction((t) => {
    const msgs = [...document.querySelectorAll(".messages .msg:not(.superseded)")];
    const mine = msgs.map((m) => m.classList.contains("user") && m.querySelector(".bubble")?.textContent?.trim() === t).lastIndexOf(true);
    const lastMsg = msgs.at(-1);
    return mine >= 0 && mine < msgs.length - 1 && lastMsg?.classList.contains("assistant") && !lastMsg.querySelector(".typing");
  }, text);
  return (await last().innerText()).trim();
}
const tab = (name) => page.locator(".tabbar").getByRole("button", { name, exact: true }).click();

await page.goto(url);
await page.getByLabel("Message").waitFor();

if (phase === "before") {
  await page.screenshot({ path: `${shots}/1-empty.png` });
  // 1. Start a conversation; 3. tell it something important.
  let r = await say("Remember that Sam Rivera is my manager");
  assert.match(r, /Sam Rivera is my manager/); log("remembered:", r);
  // 5. Ask for a reminder.
  r = await say("Remind me to follow up with John tomorrow at 10am");
  assert.match(r, /remind you to follow up with John tomorrow at 10am/); log("reminder:", r);
  await page.locator(".action-card .evidence").last().waitFor();
  r = await say("add renew passport to my list, it's urgent");
  assert.match(r, /Renew passport/); log(r);
  r = await say("I prefer meetings in the afternoon");
  assert.match(r, /unconfirmed/); log(r);
  await page.screenshot({ path: `${shots}/2-chat.png` });

  // 6. See the task in the app.
  await tab("Tasks");
  await page.getByText("Follow up with John").waitFor();
  await page.getByText("Renew passport").waitFor();
  log("tasks visible on the Tasks tab");
  await page.screenshot({ path: `${shots}/3-tasks.png` });

  // 7-8. What needs attention / the briefing.
  await tab("Today");
  await page.getByRole("heading", { name: "Focus" }).waitFor();
  await page.screenshot({ path: `${shots}/4-today.png` });
  log("Today screen shows Focus");
  await tab("Chat");
  r = await say("What should I focus on today?");
  assert.match(r, /Renew passport/); log("briefing:", r.split("\n")[0]);

  // A destructive request waits for approval; approving it in the UI runs it.
  r = await say("delete the passport task");
  assert.match(r, /approve it below/);
  await page.getByRole("button", { name: "Approve" }).last().click();
  await page.getByText("Approved and done").waitFor();
  log("approval → executed");

  // 9. Inspect actions.
  await tab("More");
  await page.locator(".more-sheet").getByRole("button", { name: "Activity" }).click();
  await page.locator(".activity").first().waitFor();
  const kinds = await page.locator(".activity .kindcode").allInnerTexts();
  assert.ok(kinds.includes("reminder.create") && kinds.includes("task.delete") && kinds.includes("memory.remember"), kinds.join(","));
  log("activity:", kinds.join(", "));
  await page.screenshot({ path: `${shots}/5-activity.png` });
  await tab("Memory");
  await page.getByText("Sam Rivera is my manager").waitFor();
  await page.screenshot({ path: `${shots}/6-memory.png` });
} else {
  // 2. The conversation is still there; 4. a new conversation recalls the memory.
  await page.getByLabel("Conversations").click();
  await page.locator(".thread").first().click();
  await page.getByText("Remember that Sam Rivera is my manager").waitFor();
  log("old conversation persisted across a server restart");
  await page.getByLabel("New conversation").click();
  const r = await say("who is Sam?");
  assert.match(r, /Sam Rivera is my manager/); log("recall in a new conversation:", r);
  await tab("Tasks");
  await page.getByText("Follow up with John").waitFor();
  assert.equal(await page.getByText("Renew passport").count(), 0, "the approved delete stuck");
  log("tasks persisted");
  await page.setViewportSize({ width: 1280, height: 820 });
  await tab("Chat").catch(() => {});
  await page.locator(".rail").getByRole("button", { name: "Today" }).click();
  await page.screenshot({ path: `${shots}/7-desktop-dark.png` });
}
await browser.close();
