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
    setTimeout(scanForShows, 1200);
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
      setTimeout(scanForShows, 1200);
    }
  }, 200);
}
history.pushState = function () { origPush.apply(this, arguments); handleNav(); };
history.replaceState = function () { origReplace.apply(this, arguments); handleNav(); };

// ═══════════════════════════════════════════════════════════════
// SHOW DETECTION
// Scans the current page for all Whatnot /live/ links and stores
// them in chrome.storage under detectedShows.
// ═══════════════════════════════════════════════════════════════

const LIVE_ID_RE = /\/live\/([a-z0-9][a-z0-9_-]{2,})/i;

function extractLiveId(href) {
  try {
    const url = new URL(href, location.href);
    if (!/whatnot\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(LIVE_ID_RE);
    return m ? m[1].toLowerCase() : null;
  } catch (_) { return null; }
}

function currentLiveId() {
  return extractLiveId(location.href);
}

function scanForShows() {
  const found = {};

  for (const a of document.querySelectorAll("a[href]")) {
    const id = extractLiveId(a.href);
    if (!id) continue;
    if (!found[id]) {
      // Try to grab a human-readable label from nearby heading or link text
      const label = (
        a.closest("article,li,[data-testid]")?.querySelector("h1,h2,h3,h4,p")?.textContent?.trim() ||
        a.textContent?.trim()
      )?.replace(/\s+/g, " ").slice(0, 72) || null;

      found[id] = {
        liveId: id,
        url: new URL(a.href, location.href).href,
        label: label || null,
        detectedAt: Date.now(),
      };
    }
  }

  // Always include the current page if it's a live page
  const curId = currentLiveId();
  if (curId && !found[curId]) {
    found[curId] = {
      liveId: curId,
      url: location.href,
      label: document.title?.split("|")[0]?.trim() || null,
      detectedAt: Date.now(),
    };
  }

  if (!Object.keys(found).length) return;

  chrome.storage.local.get(["detectedShows"], res => {
    const existing = res.detectedShows || {};
    let changed = false;
    for (const [id, show] of Object.entries(found)) {
      if (!existing[id]) {
        existing[id] = show;
        changed = true;
      } else if (show.label && !existing[id].label) {
        existing[id].label = show.label;
        changed = true;
      }
    }
    if (changed) chrome.storage.local.set({ detectedShows: existing });
  });
}

// Scan on load, on interval, and on DOM changes (debounced)
scanForShows();
setInterval(scanForShows, 20000);

let _scanDebounce = null;
new MutationObserver(() => {
  clearTimeout(_scanDebounce);
  _scanDebounce = setTimeout(scanForShows, 900);
}).observe(document.documentElement, { childList: true, subtree: true });


// ═══════════════════════════════════════════════════════════════
// MULTI-SHOW SOLD ITEM POLLING
// Polls sold items for every tracked show that isn't the current
// page (inject.js auto-poll already handles the current show).
// ═══════════════════════════════════════════════════════════════

async function fetchSoldForShow(liveId) {
  const allItems = [];
  let after = null;
  do {
    const body = JSON.stringify({
      operationName: "LiveShopSold",
      variables: { liveId, first: 48, after, filters: null, sort: null, query: "" },
      query: `query LiveShopSold($liveId:ID!,$filters:[FilterInput],$sort:ShopSortInput,$query:String,$first:Int,$after:String){liveShop(liveId:$liveId){soldItems(query:$query filters:$filters sort:$sort first:$first after:$after){pageInfo{hasNextPage endCursor}edges{node{id listing{title description transactionType pendingPayment price{amount currency}quantity}buyer{username}price{amount currency}}}}}}}`,
    });
    const res = await fetch("https://www.whatnot.com/services/graphql/?operationName=LiveShopSold&ssr=0", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "x-whatnot-app": "whatnot-web" },
      body,
    });
    if (!res.ok) break;
    const json = await res.json();
    const soldData = json?.data?.liveShop?.soldItems;
    if (!soldData) break;
    for (const e of soldData.edges || []) {
      const node = e?.node || {};
      const listing = node.listing || {};
      const totalCents = listing?.price?.amount ?? node?.price?.amount ?? 0;
      const qty = listing?.quantity || 1;
      if (node.id) {
        allItems.push({
          soldItemId: node.id,
          title: listing.title || "",
          description: listing.description || "",
          priceCents: qty > 1 ? Math.round(totalCents / qty) : totalCents,
          totalCents,
          currency: listing?.price?.currency || "USD",
          quantity: qty,
          buyer: node?.buyer?.username || null,
          transactionType: listing.transactionType || null,
          pendingPayment: listing.pendingPayment || false,
          liveId,
        });
      }
    }
    after = soldData.pageInfo?.hasNextPage ? soldData.pageInfo.endCursor : null;
  } while (after);
  return allItems;
}

async function pollTrackedShows() {
  const curId = currentLiveId();
  const res = await chrome.storage.local.get(["trackedShows", "perShowSold"]);
  const trackedShows = res.trackedShows || [];
  const perShowSold = res.perShowSold || {};

  // Skip current page — inject.js auto-poll already handles it
  const toFetch = trackedShows.filter(id => id !== curId);
  if (!toFetch.length) return;

  let changed = false;
  for (const liveId of toFetch) {
    try {
      const items = await fetchSoldForShow(liveId);
      if (items.length) { perShowSold[liveId] = items; changed = true; }
    } catch (_) {}
  }
  if (changed) chrome.storage.local.set({ perShowSold });
}

setTimeout(pollTrackedShows, 5000);
setInterval(pollTrackedShows, 45000);


// ═══════════════════════════════════════════════════════════════
// FLOATING OVERLAY
// A fixed-position bubble button (bottom-right) that expands into
// a compact panel showing break data for the current page and
// sold item counts for any tracked show selected in the dropdown.
// Uses Shadow DOM so Whatnot's CSS cannot affect it.
// ═══════════════════════════════════════════════════════════════

const OV_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :host { font-family: 'Segoe UI', system-ui, sans-serif; }

  /* ── Toggle button ── */
  #toggle {
    width: 48px; height: 48px; border-radius: 13px;
    background: #161b22; border: 1px solid #30363d;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 18px rgba(0,0,0,0.55);
    transition: transform 0.12s;
    margin-left: auto; position: relative;
  }
  #toggle:hover { transform: scale(1.07); background: #1c2333; }
  #toggle svg { width: 22px; height: 22px; }
  #sold-badge {
    position: absolute; top: -5px; right: -5px;
    background: #3fb950; color: #000; border-radius: 10px;
    font-size: 9px; font-weight: 700; padding: 1px 5px;
    display: none; line-height: 14px;
  }

  /* ── Panel ── */
  #panel {
    width: 340px; background: #0d1117;
    border: 1px solid #30363d; border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.65);
    margin-bottom: 10px; overflow: hidden; display: none;
  }
  #panel.open { display: block; }

  .hdr {
    background: #161b22; padding: 8px 12px;
    border-bottom: 1px solid #30363d;
    display: flex; align-items: center; justify-content: space-between;
  }
  .hdr-title { font-size: 12px; font-weight: 600; color: #f0f6fc; letter-spacing: 0.02em; }
  .hdr-close {
    background: none; border: none; color: #8b949e;
    cursor: pointer; font-size: 15px; padding: 0 2px; line-height: 1;
  }
  .hdr-close:hover { color: #f0f6fc; }

  /* ── Show selector ── */
  .show-bar {
    background: #0d1117; border-bottom: 1px solid #21262d;
    padding: 0;
  }
  #show-sel {
    width: 100%; padding: 7px 10px;
    background: transparent; border: none;
    color: #8b949e; font-size: 10px; cursor: pointer;
    appearance: none; font-family: inherit;
  }
  #show-sel:focus { outline: none; }
  #show-sel option { background: #161b22; color: #c9d1d9; }

  /* ── Chips ── */
  .chips {
    display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 1px; background: #21262d; border-bottom: 1px solid #21262d;
  }
  .chip { background: #0d1117; padding: 5px 2px; text-align: center; }
  .chip-lbl { font-size: 7px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b949e; margin-bottom: 2px; }
  .chip-val { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .green { color: #3fb950; } .amber { color: #f5a623; }
  .blue  { color: #58a6ff; } .purple { color: #bc8cff; }

  /* ── Spot table ── */
  .tbl-wrap { max-height: 190px; overflow-y: auto; }
  .tbl-wrap::-webkit-scrollbar { width: 3px; }
  .tbl-wrap::-webkit-scrollbar-thumb { background: #30363d; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; color: #c9d1d9; }
  th {
    padding: 5px 8px; font-size: 8px; text-transform: uppercase;
    letter-spacing: 0.06em; color: #8b949e; text-align: left;
    background: #161b22; border-bottom: 1px solid #21262d;
    position: sticky; top: 0;
  }
  td { padding: 5px 8px; border-bottom: 1px solid #21262d; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .spot-nm { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bdg { display: inline-block; padding: 1px 5px; font-size: 8px; border-radius: 10px; font-weight: 600; }
  .bdg-sold  { background: rgba(63,185,80,0.15);  color: #3fb950; }
  .bdg-avail { background: rgba(88,166,255,0.12); color: #58a6ff; }
  .price-orig { text-decoration: line-through; color: #8b949e; font-size: 9px; margin-right: 3px; }
  .price-free { color: #3fb950; }

  /* ── Footer ── */
  .foot {
    padding: 6px 10px; border-top: 1px solid #21262d;
    font-size: 10px; color: #8b949e;
    display: flex; justify-content: space-between; align-items: center;
  }
  .foot-pending { color: #f5a623; font-weight: 600; }

  .empty { padding: 14px; text-align: center; font-size: 11px; color: #8b949e; }
`;

const OV_HTML = `
  <style>${OV_STYLES}</style>
  <div id="panel">
    <div class="hdr">
      <span class="hdr-title">Break → CSV</span>
      <button class="hdr-close" id="close-btn">✕</button>
    </div>
    <div class="show-bar">
      <select id="show-sel"><option value="">— No shows detected —</option></select>
    </div>
    <div class="chips">
      <div class="chip"><div class="chip-lbl">Sold</div><div class="chip-val green"  id="ov-sold">—</div></div>
      <div class="chip"><div class="chip-lbl">Avail</div><div class="chip-val amber" id="ov-left">—</div></div>
      <div class="chip"><div class="chip-lbl">Spots</div><div class="chip-val blue"  id="ov-spots">—</div></div>
      <div class="chip"><div class="chip-lbl">Sold %</div><div class="chip-val purple" id="ov-pct">—</div></div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Spot</th><th class="num">Price</th><th>Status</th></tr></thead>
        <tbody id="ov-tbody"></tbody>
      </table>
    </div>
    <div class="foot">
      <span id="ov-sold-line">Sold items: —</span>
      <span id="ov-pending-line" class="foot-pending"></span>
    </div>
  </div>
  <button id="toggle" title="Break → CSV">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="5" width="18" height="2.5" rx="1.25" fill="#f5a623"/>
      <rect x="3" y="11" width="12" height="2.5" rx="1.25" fill="#c9d1d9"/>
      <rect x="3" y="17" width="15" height="2.5" rx="1.25" fill="#c9d1d9"/>
    </svg>
    <span id="sold-badge"></span>
  </button>
`;

function ovMoney(c) {
  return c != null ? "$" + (c / 100).toFixed(2) : "—";
}

let _shadow = null;

function createOverlay() {
  if (document.getElementById("break-csv-host")) return;

  const host = document.createElement("div");
  host.id = "break-csv-host";
  Object.assign(host.style, {
    position: "fixed", bottom: "20px", right: "20px",
    zIndex: "2147483647", display: "flex", flexDirection: "column",
    alignItems: "flex-end",
  });

  _shadow = host.attachShadow({ mode: "open" });
  _shadow.innerHTML = OV_HTML;
  document.body.appendChild(host);

  const panel   = _shadow.getElementById("panel");
  const toggle  = _shadow.getElementById("toggle");
  const closeBtn = _shadow.getElementById("close-btn");
  const showSel = _shadow.getElementById("show-sel");

  toggle.addEventListener("click", () => {
    const opening = !panel.classList.contains("open");
    panel.classList.toggle("open");
    if (opening) {
      populateShowSelector();
      refreshOverlayData();
    }
  });

  closeBtn.addEventListener("click", () => panel.classList.remove("open"));
  showSel.addEventListener("change", () => refreshOverlayData());

  chrome.storage.onChanged.addListener(() => {
    populateShowSelector();
    if (panel.classList.contains("open")) refreshOverlayData();
    updateBadge();
  });

  updateBadge();
}

function populateShowSelector() {
  if (!_shadow) return;
  const sel = _shadow.getElementById("show-sel");
  chrome.storage.local.get(["detectedShows", "trackedShows"], res => {
    const detected = res.detectedShows || {};
    const tracked  = new Set(res.trackedShows || []);
    const ids = Object.keys(detected);
    const prev = sel.value;

    sel.innerHTML = "";

    if (!ids.length) {
      sel.innerHTML = '<option value="">— No shows detected —</option>';
      return;
    }

    // Sort: tracked first, then by detectedAt
    ids.sort((a, b) => {
      if (tracked.has(a) !== tracked.has(b)) return tracked.has(a) ? -1 : 1;
      return (detected[b].detectedAt || 0) - (detected[a].detectedAt || 0);
    });

    for (const id of ids) {
      const s = detected[id];
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = (tracked.has(id) ? "✓ " : "") + (s.label || id).slice(0, 44);
      opt.selected = id === prev;
      sel.appendChild(opt);
    }

    // Auto-select current page's show if nothing is selected
    if (!sel.value) {
      const curId = currentLiveId();
      if (curId && detected[curId]) sel.value = curId;
    }
  });
}

function refreshOverlayData() {
  if (!_shadow) return;
  const sel = _shadow.getElementById("show-sel");
  const selectedId = sel?.value || currentLiveId();

  chrome.storage.local.get(["whatnotRows", "whatnotSoldItems", "perShowSold"], res => {
    const rows = res.whatnotRows || [];
    const perShowSold = res.perShowSold || {};
    const curId = currentLiveId();

    // Sold items: use perShowSold for tracked non-current shows, whatnotSoldItems for current
    const soldItems = (selectedId && selectedId !== curId && perShowSold[selectedId])
      ? perShowSold[selectedId]
      : (res.whatnotSoldItems || []);

    // ── Chips ──
    let soldVal = 0, availVal = 0, soldCount = 0;
    for (const r of rows) {
      if (r.buyer) { soldVal += r.priceCents || 0; soldCount++; }
      else availVal += r.priceCents || 0;
    }
    const pct = rows.length ? Math.round(soldCount / rows.length * 100) : 0;

    _shadow.getElementById("ov-sold").textContent  = rows.length ? ovMoney(soldVal) : "—";
    _shadow.getElementById("ov-left").textContent  = rows.length ? ovMoney(availVal) : "—";
    _shadow.getElementById("ov-spots").textContent = rows.length || "—";
    _shadow.getElementById("ov-pct").textContent   = rows.length ? pct + "%" : "—";

    // ── Spot rows ──
    const tbody = _shadow.getElementById("ov-tbody");
    tbody.innerHTML = "";

    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 3; td.className = "empty";
      td.textContent = "No break data — open the break panel on stream";
      tr.appendChild(td); tbody.appendChild(tr);
    } else {
      for (const r of rows) {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.className = "spot-nm";
        tdName.title = r.spotTitle || "";
        tdName.textContent = r.spotTitle || "—";

        const tdPrice = document.createElement("td");
        tdPrice.className = "num";
        if (r.isGiveaway) {
          tdPrice.className += " price-free";
          tdPrice.textContent = "FREE";
        } else if (r.originalPriceDisplay && r.discountPct != null && r.discountPct < 100) {
          const s = document.createElement("span");
          s.className = "price-orig";
          s.textContent = r.originalPriceDisplay;
          tdPrice.appendChild(s);
          tdPrice.appendChild(document.createTextNode(r.priceDisplay || ovMoney(r.priceCents)));
        } else {
          tdPrice.textContent = r.priceDisplay || ovMoney(r.priceCents);
        }

        const tdStatus = document.createElement("td");
        const b = document.createElement("span");
        b.className = "bdg " + (r.buyer ? "bdg-sold" : "bdg-avail");
        b.textContent = r.buyer ? "Sold" : "Avail";
        tdStatus.appendChild(b);

        tr.append(tdName, tdPrice, tdStatus);
        tbody.appendChild(tr);
      }
    }

    // ── Footer ──
    const pending = soldItems.filter(i => i.pendingPayment).length;
    _shadow.getElementById("ov-sold-line").textContent = `Sold items: ${soldItems.length || "—"}`;
    _shadow.getElementById("ov-pending-line").textContent = pending ? `${pending} pending` : "";
  });
}

function updateBadge() {
  if (!_shadow) return;
  chrome.storage.local.get(["whatnotRows"], res => {
    const soldCount = (res.whatnotRows || []).filter(r => r.buyer).length;
    const badge = _shadow.getElementById("sold-badge");
    if (soldCount > 0) {
      badge.textContent = soldCount;
      badge.style.display = "block";
    } else {
      badge.style.display = "none";
    }
  });
}

// Init overlay after DOM ready
if (document.body) createOverlay();
else document.addEventListener("DOMContentLoaded", createOverlay);
