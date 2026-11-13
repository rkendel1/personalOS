// Injected on demand (chrome.scripting.executeScript) into the tab the person is looking at, after
// they ask PersonalOS about it. Nothing runs on a page until then. Returns what the person can see.
(() => {
  const root = document.querySelector("article, main, [role=main]") || document.body;
  const clean = (t) => t.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const selection = String(getSelection() || "").trim();
  return {
    title: document.title || location.hostname,
    url: location.href,
    // One past PersonalOS's limit, so a longer selection is refused with its size, never cut silently.
    selection: selection.slice(0, 20001),
    text: clean(root.innerText || "").slice(0, 200000),
  };
})();
