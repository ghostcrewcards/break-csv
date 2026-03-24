const money = c => c != null ? "$" + (c / 100).toFixed(2) : "—";

// ── Render breaks ──
function renderBreaks(rows) {
  const tbody = document.getElementById("tbody-breaks");
  const status = document.getElementById("status-breaks");
  tbody.innerHTML = "";

  if (!rows?.length) {
    status.textContent = "No break data yet — open a Whatnot or Fanatics Live stream.";
    document.getElementById("s-sold").textContent = "—";
    document.getElementById("s-left").textContent = "—";
    document.getElementById("s-spots").textContent = "—";
    document.getElementById("s-pct").textContent = "—";
    return;
  }

  let sold = 0, left = 0, soldCount = 0;
  for (const r of rows) {
    if (r.buyer) { sold += r.priceCents || 0; soldCount++; }
    else left += r.priceCents || 0;

    const tr = document.createElement("tr");

    const tdSpot = document.createElement("td");
    tdSpot.style.cssText = "max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    tdSpot.title = r.spotTitle || "";
    if (r.platform) {
      const platBadge = document.createElement("span");
      platBadge.className = "badge badge-plat-" + r.platform;
      platBadge.textContent = r.platform === "fanatics" ? "FL" : "WN";
      tdSpot.appendChild(platBadge);
    }
    tdSpot.appendChild(document.createTextNode(r.spotTitle || "—"));

    const tdPrice = document.createElement("td");
    tdPrice.className = "num";
    if (r.isGiveaway) {
      tdPrice.className += " price-free";
      tdPrice.textContent = "FREE";
    } else if (r.originalPriceDisplay && r.discountPct != null && r.discountPct < 100) {
      const orig = document.createElement("span");
      orig.className = "price-orig";
      orig.textContent = r.originalPriceDisplay;
      tdPrice.appendChild(orig);
      tdPrice.appendChild(document.createTextNode(r.priceDisplay || money(r.priceCents)));
    } else {
      tdPrice.textContent = r.priceDisplay || money(r.priceCents);
    }

    const badge = document.createElement("span");
    badge.className = "badge " + (r.buyer ? "badge-sold" : "badge-avail");
    badge.textContent = r.buyer ? "Sold" : "Avail";
    const tdStatus = document.createElement("td");
    tdStatus.appendChild(badge);

    const tdBuyer = document.createElement("td");
    tdBuyer.style.cssText = "color:#8b949e;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    tdBuyer.textContent = r.buyer || "";

    tr.append(tdSpot, tdPrice, tdStatus, tdBuyer);
    tbody.appendChild(tr);
  }

  const pct = Math.round(soldCount / rows.length * 100);
  document.getElementById("s-sold").textContent = money(sold);
  document.getElementById("s-left").textContent = money(left);
  document.getElementById("s-spots").textContent = rows.length;
  document.getElementById("s-pct").textContent = pct + "%";
  status.textContent = `${rows.length} spots · ${soldCount} sold · ${pct}% sell-through`;
}

// ── Render sold items ──
function renderSold(items) {
  const tbody = document.getElementById("tbody-sold");
  const status = document.getElementById("status-sold");
  tbody.innerHTML = "";

  if (!items?.length) {
    status.textContent = "Sold items are fetched automatically on Whatnot live pages.";
    document.getElementById("si-count").textContent = "—";
    document.getElementById("si-pending").textContent = "—";
    document.getElementById("si-total").textContent = "—";
    return;
  }

  let total = 0, pending = 0;
  for (const item of items) {
    if (item.pendingPayment) pending++;
    total += item.totalCents || item.priceCents || 0;

    const tr = document.createElement("tr");

    const tdTitle = document.createElement("td");
    tdTitle.style.cssText = "max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    tdTitle.title = item.title || "";
    tdTitle.textContent = item.title || "—";

    const tdPrice = document.createElement("td");
    tdPrice.className = "num";
    tdPrice.textContent = money(item.priceCents);

    const tdQty = document.createElement("td");
    tdQty.textContent = item.quantity ?? 1;

    const tdBuyer = document.createElement("td");
    tdBuyer.style.cssText = "color:#8b949e;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    tdBuyer.textContent = item.buyer || "";

    tr.append(tdTitle, tdPrice, tdQty, tdBuyer);
    tbody.appendChild(tr);
  }

  document.getElementById("si-count").textContent = items.length;
  document.getElementById("si-pending").textContent = pending;
  document.getElementById("si-total").textContent = money(total);
  status.textContent = `${items.length} items · ${money(total)} total${pending ? ` · ${pending} pending` : ""}`;
}

// ── Render detected shows ──
function renderShows(detectedShows, trackedShows) {
  const list = document.getElementById("show-list");
  const detected = Object.values(detectedShows || {});
  const tracked  = new Set(trackedShows || []);

  if (!detected.length) {
    list.innerHTML = '<div class="show-empty">Navigate to Whatnot to detect shows.</div>';
    return;
  }

  // Sort: tracked first, then most recently detected
  detected.sort((a, b) => {
    if (tracked.has(a.liveId) !== tracked.has(b.liveId))
      return tracked.has(a.liveId) ? -1 : 1;
    return (b.detectedAt || 0) - (a.detectedAt || 0);
  });

  list.innerHTML = "";
  for (const show of detected) {
    const isTracked = tracked.has(show.liveId);

    const row = document.createElement("div");
    row.className = "show-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isTracked;
    cb.addEventListener("change", () => toggleTrackShow(show.liveId, cb.checked));

    const lbl = document.createElement("span");
    lbl.className = "show-label" + (isTracked ? " tracked" : "");
    lbl.title = show.url || show.liveId;
    lbl.textContent = show.label || show.liveId;

    row.append(cb, lbl);
    list.appendChild(row);
  }
}

function toggleTrackShow(liveId, track) {
  chrome.storage.local.get(["trackedShows"], res => {
    let tracked = res.trackedShows || [];
    if (track) { if (!tracked.includes(liveId)) tracked.push(liveId); }
    else tracked = tracked.filter(id => id !== liveId);
    chrome.storage.local.set({ trackedShows: tracked }, loadData);
  });
}

// ── Load all data ──
function loadData() {
  chrome.storage.local.get(["whatnotRows", "whatnotSoldItems", "detectedShows", "trackedShows"], res => {
    renderBreaks(res.whatnotRows || []);
    renderSold(res.whatnotSoldItems || []);
    renderShows(res.detectedShows, res.trackedShows);
  });
}

// ── Share to ChatGPT ──
document.getElementById("gptBreakBtn").addEventListener("click", () => {
  chrome.storage.local.get(["whatnotRows", "lastBreak"], res => {
    const rows = res.whatnotRows || [];
    if (!rows.length) return alert("No break data to share.");

    let soldVal = 0, availVal = 0;
    for (const r of rows) {
      if (r.buyer) soldVal += r.priceCents || 0;
      else availVal += r.priceCents || 0;
    }
    const totalVal = soldVal + availVal;
    const soldCount = rows.filter(r => r.buyer).length;
    const platform = rows[0]?.platform === "fanatics" ? "Fanatics Live" : "Whatnot";
    const breakTitle = rows[0]?.breakTitle || "Unknown Break";
    const currency = rows[0]?.currency || "USD";

    const fmt = c => c != null ? "$" + (c / 100).toFixed(2) : "—";

    const gptPct = Math.round(soldCount / rows.length * 100);
    const header = [
      `I have break spot data from ${platform} that I'd like your help analyzing.`,
      ``,
      `Break: ${breakTitle}`,
      `Platform: ${platform}`,
      `Total spots: ${rows.length} | Sold: ${soldCount} | Available: ${rows.length - soldCount} | Sell-through: ${gptPct}%`,
      `Sold value: ${fmt(soldVal)} | Available value: ${fmt(availVal)} | Total: ${fmt(totalVal)}`,
      `Currency: ${currency}`,
      ``,
      `Spot list:`,
      `Spot | Price | Status | Buyer`,
      `-----|-------|--------|------`,
    ];

    const spotLines = rows.map(r => {
      const price = r.isGiveaway ? "FREE" : (r.priceDisplay || fmt(r.priceCents));
      const status = r.isSold ? "Sold" : "Available";
      const buyer = r.buyer || "—";
      return `${r.spotTitle} | ${price} | ${status} | ${buyer}`;
    });

    const footer = [
      ``,
      `Please provide a summary and any insights — sell-through rate, revenue breakdown, notable spots, etc.`,
    ];

    const prompt = [...header, ...spotLines, ...footer].join("\n");

    navigator.clipboard.writeText(prompt).then(() => {
      chrome.tabs.create({ url: "https://chatgpt.com/" });
      const status = document.getElementById("status-breaks");
      const prev = status.textContent;
      status.textContent = "✓ Copied to clipboard — paste into ChatGPT";
      status.style.color = "#10a37f";
      setTimeout(() => { status.textContent = prev; status.style.color = ""; }, 3000);
    }).catch(() => alert("Clipboard access denied. Try again."));
  });
});

// ── Export breaks ──
document.getElementById("exportBreakBtn").addEventListener("click", () => {
  chrome.storage.local.get(["whatnotRows", "lastBreak"], res => {
    const rows = res.whatnotRows || [];
    if (!rows.length) return alert("No break data to export.");

    const lines = [["Break Title","Spot Title","Description","Price","Currency","Status","Buyer"].join(",")];
    let sold = 0, left = 0, all = 0;
    for (const r of rows) {
      const cents = r.priceCents || 0;
      all += cents;
      if (r.buyer) sold += cents; else left += cents;
      lines.push([r.breakTitle, r.spotTitle, r.description, (cents/100).toFixed(2), r.currency, r.buyer ? "Sold" : "Available", r.buyer || ""]
        .map(v => `"${(v || "").replace(/"/g, '""')}"`).join(","));
    }
    lines.push("", `"Total Sold",,,${(sold/100).toFixed(2)},${rows[0]?.currency || ""}`,
                    `"Total Left",,,${(left/100).toFixed(2)},${rows[0]?.currency || ""}`,
                    `"Grand Total",,,${(all/100).toFixed(2)},${rows[0]?.currency || ""}`);

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    chrome.downloads.download({ url: URL.createObjectURL(blob), filename: `whatnot_breaks_${res.lastBreak || "export"}.csv`, saveAs: true });
    chrome.storage.local.set({ whatnotRows: [], lastBreak: null });
    chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
    loadData();
  });
});

// ── Export sold items ──
document.getElementById("exportSoldBtn").addEventListener("click", () => {
  chrome.storage.local.get(["whatnotSoldItems"], res => {
    const items = res.whatnotSoldItems || [];
    if (!items.length) return alert("No sold item data to export.");

    const lines = [["Title","Description","Unit Price","Total Price","Currency","Quantity","Buyer","Transaction Type"].join(",")];
    let grandTotal = 0;
    for (const item of items) {
      grandTotal += item.totalCents || item.priceCents || 0;
      lines.push([
        item.title, item.description,
        ((item.priceCents || 0)/100).toFixed(2),
        ((item.totalCents || item.priceCents || 0)/100).toFixed(2),
        item.currency || "USD",
        item.quantity ?? 1,
        item.buyer || "",
        item.transactionType || ""
      ].map(v => `"${(String(v || "")).replace(/"/g, '""')}"`).join(","));
    }
    lines.push("", `"Grand Total",,,,${(grandTotal/100).toFixed(2)}`);

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    chrome.downloads.download({ url: URL.createObjectURL(blob), filename: `whatnot_sold_${Date.now()}.csv`, saveAs: true });
    chrome.storage.local.set({ whatnotSoldItems: [] });
    loadData();
  });
});

// ── Clear breaks ──
document.getElementById("clearBreakBtn").addEventListener("click", () => {
  chrome.storage.local.set({ whatnotRows: [], lastBreak: null });
  chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
  loadData();
});

// ── Clear sold items ──
document.getElementById("clearSoldBtn").addEventListener("click", () => {
  chrome.storage.local.set({ whatnotSoldItems: [] });
  loadData();
});

// ── Clear detected shows ──
document.getElementById("clearShowsBtn").addEventListener("click", () => {
  chrome.storage.local.set({ detectedShows: {}, trackedShows: [], perShowSold: {} });
  loadData();
});

// Clear badge on popup open
chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });

// Init
loadData();
