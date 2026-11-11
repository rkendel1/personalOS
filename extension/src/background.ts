/**
 * Service worker. It owns only what must exist outside the panel: the toolbar button opens the
 * side panel, and the right-click menu hands a selection, link or page to it. It never talks to the
 * PersonalOS instance and holds no session; the panel does that, as the signed-in person.
 */
import { lockStorage, PENDING_KEY, type Pending } from "./config";

// Lock the session's storage away from content scripts whenever the worker starts (install, update, browser start).
void lockStorage();
chrome.runtime.onStartup.addListener(() => void lockStorage());

chrome.runtime.onInstalled.addListener(() => {
  void lockStorage();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "ask", title: "Ask PersonalOS about “%s”", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "task", title: "Add to my PersonalOS tasks", contexts: ["selection", "link", "page"] });
    chrome.contextMenus.create({ id: "page", title: "Save this page to PersonalOS", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const pending: Pending =
    info.menuItemId === "ask" ? { kind: "ask", text: info.selectionText ?? "", url: tab.url, title: tab.title }
    : info.menuItemId === "task" ? { kind: "task", text: info.selectionText || info.linkUrl || "", url: info.linkUrl || tab.url, title: tab.title }
    : { kind: "page", url: tab.url, title: tab.title };
  // Open first, in the same user gesture; then leave the request for the panel (it may already be open).
  void chrome.sidePanel.open({ tabId: tab.id });
  void chrome.storage.session.set({ [PENDING_KEY]: pending });
});
