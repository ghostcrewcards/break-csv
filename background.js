chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SET_BADGE") {
    const count = msg.count || 0;
    chrome.action.setBadgeBackgroundColor({ color: "#1976d2" });
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  }

  if (msg.type === "CLEAR_BADGE") {
    chrome.action.setBadgeText({ text: "" });
  }
});
