(function injectPageScript() {
  try {
    const scriptUrl = chrome.runtime.getURL("inject.js");
    const s = document.createElement("script");
    s.src = scriptUrl;
    s.type = "text/javascript";
    s.onload = function () {
      console.log("[Whatnot CSV] inject.js loaded successfully");
      this.remove();
    };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    console.warn("[Whatnot CSV] Failed to inject script:", e);
  }
})();

// === Listen for messages from inject.js ===
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;

  if (data?.type === "WHATNOT_BREAK_DATA") {
    const rows = data.rows || [];
    const breakId = data.breakId || null;
    chrome.storage.local.set({ whatnotRows: rows, lastBreak: breakId }, () => {
      chrome.runtime.sendMessage({ type: "SET_BADGE", count: rows.length });
    });
  }

  if (data?.type === "WHATNOT_SOLD_DATA") {
    const incoming = data.items || [];
    chrome.storage.local.get(["whatnotSoldItems"], res => {
      const existing = res.whatnotSoldItems || [];
      const byId = {};
      for (const i of existing) if (i.soldItemId) byId[i.soldItemId] = i;
      for (const i of incoming) if (i.soldItemId) byId[i.soldItemId] = i;
      chrome.storage.local.set({ whatnotSoldItems: Object.values(byId) });
    });
  }
});

// === SPA navigation detection ===
let lastURL = location.href;
const urlObserver = new MutationObserver(() => {
  if (location.href !== lastURL) {
    lastURL = location.href;
    console.log("[Whatnot CSV] Navigated to new show, clearing data");
    chrome.storage.local.set({ whatnotRows: [], lastBreak: null, whatnotSoldItems: [] });
    chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
  }
});
urlObserver.observe(document, { subtree: true, childList: true });

const origPush = history.pushState;
const origReplace = history.replaceState;
function handleNav() {
  setTimeout(() => {
    if (location.href !== lastURL) {
      lastURL = location.href;
      chrome.storage.local.set({ whatnotRows: [], lastBreak: null, whatnotSoldItems: [] });
      chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
    }
  }, 200);
}
history.pushState = function () { origPush.apply(this, arguments); handleNav(); };
history.replaceState = function () { origReplace.apply(this, arguments); handleNav(); };
