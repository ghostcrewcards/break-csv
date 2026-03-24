// inject.js — Whatnot + Fanatics Live Break → CSV (public edition)
(() => {
  if (window.__WHATNOT_CSV_HOOKED__) return;
  window.__WHATNOT_CSV_HOOKED__ = true;

  const log = (...a) => { try { console.debug("[Whatnot CSV]", ...a); } catch (_) {} };

  // === State ===
  let ACC = [];
  let LAST_BREAK_ID = null;
  // Cache descriptions from paginatedSpotOptions keyed by spotTitle (lowercased).
  // Sold BreakSpot nodes don't carry descriptions, so we fill them in from here.
  const DESCRIPTION_CACHE = {};

  // ─────────────────────────────────────────────
  // EXTRACTOR
  // Two completely different data shapes depending on break format:
  //
  // RANDOM breaks:
  //   - Unsold spots → paginatedSpotOptions  (BreakSpotOption nodes, no price, available:true)
  //   - Sold spots   → paginatedSpots SOLD   (BreakSpot nodes, have buyer + listing.price)
  //
  // PICK_YOUR / STANDARD breaks:
  //   - All spots    → paginatedSpots        (BreakSpot nodes, unsold have no buyer, sold have buyer)
  //   - paginatedSpotOptions always empty
  // ─────────────────────────────────────────────
  function extractRowsFromGraphQL(json) {
    try {
      const d = json && json.data;
      if (!d) return null;

      const rows = [];
      let breakMeta = null;

      // Capture break-level metadata from any getBreak-shaped node
      const captureBreakMeta = (node) => {
        if (!node?.id) return;
        if (breakMeta) return; // keep first (most complete) one
        breakMeta = {
          breakId: String(node.id),
          format: node.format || "STANDARD",
          totalBreakSpots: node.totalBreakSpots || null,
          soldSpotCount: node.soldSpotCount || null,
          seller: node.seller?.username || node.user?.username || node.owner?.username || null
        };
      };

      // Parse BreakSpot edges (paginatedSpots) — used by both RANDOM (sold) and PICK_YOUR (all)
      const parseBreakSpots = (edges, breakTitle, soldOverride = null) => {
        const local = [];
        for (const e of edges || []) {
          const node = e?.node || e;
          if (!node) continue;
          const listing = node.listing || {};
          const priceCents = listing?.price?.amount ?? node?.price?.amount ?? 0;
          const currency = listing?.price?.currency || node?.price?.currency || "USD";
          const buyer = node?.buyer?.username || node?.assignedTo?.username ||
                        node?.assignment?.user?.username || null;
          if (!node.title && !buyer && !priceCents) continue;
          const isSold = soldOverride !== null ? soldOverride : !!buyer;
          const spotKey = (node.title || node.name || "").toLowerCase();
          const description = node.description || DESCRIPTION_CACHE[spotKey] || "";
          local.push({
            breakTitle: breakTitle || "(Untitled Break)",
            spotTitle: node.title || node.name || "",
            description,
            priceCents,
            currency,
            buyer,
            isSold,
            isSpotOption: false,
            spotId: node.id ? String(node.id) : null,
            listingId: listing.id || null,
            platform: "whatnot",
            isGiveaway: false
          });
        }
        return local;
      };

      // Parse BreakSpotOption edges (paginatedSpotOptions) — RANDOM breaks only, unsold slots
      // These have NO price and NO buyer — they're just the team/character slots available to buy
      const parseSpotOptions = (edges, breakTitle) => {
        const local = [];
        for (const e of edges || []) {
          const node = e?.node || e;
          if (!node) continue;
          if (!node.title) continue;
          const desc = node.description || "";
          if (desc) DESCRIPTION_CACHE[(node.title || "").toLowerCase()] = desc;
          local.push({
            breakTitle: breakTitle || "(Untitled Break)",
            spotTitle: node.title || "",
            description: desc,
            priceCents: null, // Random spots have no fixed price
            currency: "USD",
            buyer: null,
            isSold: false,
            isSpotOption: true,
            spotId: node.id ? String(node.id) : null,
            listingId: null,
            platform: "whatnot",
            isGiveaway: false
          });
        }
        return local;
      };

      // --- Process all possible break nodes ---
      const possibleBreakNodes = [
        d.getBreak, d.getBreakDetails, d.getBreakDetailsV2,
        d.breakDetailsV2, d.viewer?.sellerBreak,
      ];

      for (const node of possibleBreakNodes.filter(Boolean)) {
        captureBreakMeta(node);
        const title = node.title;

        // paginatedSpots — BreakSpot nodes (PICK_YOUR unsold+sold, or RANDOM sold-only)
        if (node.paginatedSpots?.edges?.length) {
          rows.push(...parseBreakSpots(node.paginatedSpots.edges, title));
        }
        // spots (legacy)
        else if (node.spots?.edges?.length) {
          rows.push(...parseBreakSpots(node.spots.edges, title));
        }

        // paginatedSpotOptions — BreakSpotOption nodes (RANDOM unsold slots only)
        if (node.paginatedSpotOptions?.edges?.length) {
          rows.push(...parseSpotOptions(node.paginatedSpotOptions.edges, title));
        }
      }

      // Legacy endpoint
      if (Array.isArray(d.getBreaksForLiveStream?.items)) {
        for (const item of d.getBreaksForLiveStream.items) {
          const bn = item.break;
          if (!bn) continue;
          captureBreakMeta(bn);
          const edges = bn?.paginatedSpots?.edges || bn?.spots?.edges;
          if (edges) rows.push(...parseBreakSpots(edges, bn.title));
          if (bn?.paginatedSpotOptions?.edges?.length)
            rows.push(...parseSpotOptions(bn.paginatedSpotOptions.edges, bn.title));
        }
      }

      if (d.soldBreakSpots?.paginatedSpots?.edges)
        rows.push(...parseBreakSpots(d.soldBreakSpots.paginatedSpots.edges, "Sold Spots", true));
      if (d.unsoldBreakSpots?.paginatedSpots?.edges)
        rows.push(...parseBreakSpots(d.unsoldBreakSpots.paginatedSpots.edges, "Unsold Spots", false));

      if (rows.length || breakMeta) {
        if (rows.length) log(`✅ Parsed ${rows.length} rows (format=${breakMeta?.format})`);
        return { rows, breakMeta };
      }
    } catch (err) {
      log("extract error", err);
    }
    return null;
  }

  // === Fanatics Live Extractor ===
  function extractFanaticsRowsFromGraphQL(json) {
    try {
      const breakData = json?.data?.break;
      if (!Array.isArray(breakData?.breakItems) || !breakData.breakItems.length) return null;

      const breakTitle = breakData.title || "(Untitled Break)";
      const breakId = breakData.id ? String(breakData.id) : null;

      const rows = breakData.breakItems.map(item => {
        const isGiveaway = item.priceDiscountPercentage === 100 && (item.price?.amount ?? 0) === 0;
        return {
          breakTitle,
          spotTitle: item.label || "",
          abbreviation: item.labelAbbreviation || null,
          spotNumber: item.spotNumber ?? null,
          description: "",
          priceCents: item.price?.amount ?? 0,
          priceDisplay: item.price?.amountDisplay || null,
          currency: item.price?.currency || "USD",
          originalPriceCents: item.previousPrice?.amount ?? null,
          originalPriceDisplay: item.previousPrice?.amountDisplay || null,
          discountPct: item.priceDiscountPercentage ?? null,
          buyer: item.user?.username || null,
          isSold: !!item.user,
          isGiveaway,
          isSpotOption: false,
          spotId: item.id ? String(item.id) : null,
          listingId: null,
          platform: "fanatics"
        };
      });

      const breakMeta = {
        breakId,
        format: breakData.selectionType || breakData.pricingType || "STANDARD",
        totalBreakSpots: breakData.breakItemsCounts?.total || null,
        soldSpotCount: breakData.breakItemsCounts?.sold || null,
        seller: null
      };

      log(`✅ Fanatics: Parsed ${rows.length} rows`);
      return { rows, breakMeta };
    } catch (err) {
      log("fanatics extract error", err);
    }
    return null;
  }

  // === Deduplication ===
  function dedupeRows(arr) {
    const soldTitles = new Set(arr.filter(r => r.isSold && !r.isSpotOption).map(r => r.spotTitle));

    const seen = new Set();
    const out = [];
    for (const r of arr) {
      if (r.isSpotOption && !r.isSold && soldTitles.has(r.spotTitle)) continue;

      const key = [r.breakTitle, r.spotTitle, r.description || "", r.priceCents ?? "null",
        r.currency, r.buyer || "", r.listingId || "", r.spotId || ""].join("§");
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    return out;
  }

  // === Merge and post to extension storage ===
  function mergeAndPost(newRows, incomingBreakId) {
    if (!Array.isArray(newRows) || !newRows.length) return;

    const breakId = incomingBreakId || LAST_BREAK_ID;

    if (breakId && breakId !== LAST_BREAK_ID) {
      log(`🔄 New break (${breakId}), resetting ACC`);
      ACC = [];
    }

    if (breakId) LAST_BREAK_ID = breakId;

    ACC = dedupeRows([...ACC, ...newRows]);

    window.postMessage({ type: "WHATNOT_BREAK_DATA", rows: ACC, breakId: LAST_BREAK_ID }, "*");
    log(`📦 ACC=${ACC.length} (${ACC.filter(r=>r.isSold&&!r.isSpotOption).length} sold, ${ACC.filter(r=>r.isSpotOption).length} spotOptions)`);
  }

  // === Unified Fetch Hook ===
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (!url.includes("/graphql")) return res;

      const bodyText = typeof args[1]?.body === "string" ? args[1].body : null;
      const isLiveShopSold = bodyText?.includes("LiveShopSold");

      const clone = res.clone();
      clone.text().then(async (txt) => {
        try {
          const json = JSON.parse(txt);

          if (isLiveShopSold) {
            const reqBody = JSON.parse(bodyText);
            const liveId = reqBody?.variables?.liveId;
            if (!liveId) return;
            const edges = json?.data?.liveShop?.soldItems?.edges || [];
            if (!edges.length) return;
            const items = edges.map(e => {
              const node = e?.node || {};
              const listing = node.listing || {};
              const totalCents = listing?.price?.amount ?? node?.price?.amount ?? 0;
              const currency = listing?.price?.currency || "USD";
              const buyer = node?.buyer?.username || listing?.currentBidUser?.username || null;
              const qty = listing?.quantity || 1;
              const priceCents = qty > 1 ? Math.round(totalCents / qty) : totalCents;
              return {
                soldItemId: node.id || null,
                listingId: listing.id || null,
                title: listing.title || "",
                description: listing.description || "",
                priceCents,
                totalCents,
                currency,
                quantity: qty,
                buyer,
                transactionType: listing.transactionType || null,
              pendingPayment: listing.pendingPayment || false
              };
            }).filter(i => i.soldItemId);
            if (items.length) {
              log(`🛒 LiveShopSold: ${items.length} items`);
              window.postMessage({ type: "WHATNOT_SOLD_DATA", items, liveId }, "*");
            }
            return;
          }

          const hit = extractRowsFromGraphQL(json) || extractFanaticsRowsFromGraphQL(json);
          if (hit?.rows?.length) mergeAndPost(hit.rows, hit.breakMeta?.breakId || null);
        } catch (_) {}
      }).catch(() => {});
    } catch (_) {}
    return res;
  };

  // === Auto-poll: sold items on Whatnot live pages ===
  // Fetches all sold items via paginated GraphQL so the user doesn't need
  // to manually scroll the Sold tab. Runs every 45 seconds while on a live page.
  function getLiveIdFromUrl() {
    const m = location.pathname.match(/\/live\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  let AUTO_POLL_TIMER = null;

  async function pollSoldItems() {
    const liveId = getLiveIdFromUrl();
    if (!liveId) return;

    try {
      const allItems = [];
      let after = null;

      do {
        const body = JSON.stringify({
          operationName: "LiveShopSold",
          variables: { liveId, first: 48, after, filters: null, sort: null, query: "" },
          query: `query LiveShopSold($liveId:ID!,$filters:[FilterInput],$sort:ShopSortInput,$query:String,$first:Int,$after:String){liveShop(liveId:$liveId){soldItems(query:$query filters:$filters sort:$sort first:$first after:$after){pageInfo{hasNextPage endCursor}edges{node{id listing{title description transactionType pendingPayment price{amount currency}quantity}buyer{username}price{amount currency}}}}}}`,
        });

        const res = await _fetch("https://www.whatnot.com/services/graphql/?operationName=LiveShopSold&ssr=0", {
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
          const currency = listing?.price?.currency || "USD";
          const buyer = node?.buyer?.username || null;
          const qty = listing?.quantity || 1;
          const priceCents = qty > 1 ? Math.round(totalCents / qty) : totalCents;
          if (node.id) {
            allItems.push({
              soldItemId: node.id,
              listingId: null,
              title: listing.title || "",
              description: listing.description || "",
              priceCents,
              totalCents,
              currency,
              quantity: qty,
              buyer,
              transactionType: listing.transactionType || null,
              pendingPayment: listing.pendingPayment || false,
            });
          }
        }

        after = soldData.pageInfo?.hasNextPage ? soldData.pageInfo.endCursor : null;
      } while (after);

      if (allItems.length) {
        log(`🔄 Auto-poll: ${allItems.length} sold items`);
        window.postMessage({ type: "WHATNOT_SOLD_DATA", items: allItems, liveId }, "*");
      }
    } catch (err) {
      log("auto-poll error", err);
    }
  }

  function startAutoPoll() {
    if (AUTO_POLL_TIMER) { clearInterval(AUTO_POLL_TIMER); AUTO_POLL_TIMER = null; }
    if (!getLiveIdFromUrl()) return;
    log("🔁 Starting auto-poll for sold items");
    setTimeout(pollSoldItems, 3000);
    AUTO_POLL_TIMER = setInterval(pollSoldItems, 45000);
  }

  startAutoPoll();
  window.addEventListener("popstate", () => setTimeout(startAutoPoll, 1500));

  log("✅ Break CSV hooks installed (Whatnot + Fanatics Live, public edition)");
})();
