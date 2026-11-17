// Injected into the active tab only when the user presses "Capture".
// It is strictly read-only: it reads the DOM and returns plain data. It never
// clicks, types, scrolls, submits, or modifies anything on the page, and it
// makes no network requests. The value of the final expression is what
// scripting.executeScript() hands back to the popup.
(() => {
  // Travian wraps numbers in bidi control characters (U+202A..U+202E etc).
  const clean = (s) => (s || "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  const text = (el) => clean(el ? el.textContent : "");
  const int = (s) => {
    const digits = (s || "").replace(/[^\d]/g, "");
    return digits ? parseInt(digits, 10) : null;
  };

  function splitBidder(raw) {
    // "gence26 (KING)" -> name + alliance; "Maja" -> no alliance.
    const m = raw.match(/^(.*\S)\s*\(([^()]*)\)$/);
    return m ? { bidder: m[1], alliance: m[2] } : { bidder: raw, alliance: null };
  }

  function parseRow(tr) {
    const info = tr.querySelector("td.itemInformation");
    const priceCell = tr.querySelector("td.price");
    if (!info || !priceCell) return null;

    const itemName = text(info.querySelector("strong")) || text(info);
    const qty = text(info).match(/\(x\s*([\d.,\s]+)\)/i);
    const icon = tr.querySelector("td.heroItemImage .item");
    const typeMatch = icon && (icon.getAttribute("class") || "").match(/\bitem(\d+)\b/);
    const bidderRaw = text(tr.querySelector("td.highestBidder"));
    // A running auction has a countdown timer; a finished one does not.
    // Checking the element instead of the word "Finished" keeps this
    // independent of the game language.
    const finished = !tr.querySelector("td.finishedAt .timerReact");

    return {
      itemName,
      itemTypeId: typeMatch ? parseInt(typeMatch[1], 10) : null,
      quantity: qty ? int(qty[1]) : 1,
      price: int(text(priceCell)),
      bidderRaw,
      ...splitBidder(bidderRaw),
      bids: int(text(tr.querySelector("td.bidCount"))),
      finished,
    };
  }

  // Which way finished auctions are ordered: "newestFirst", "oldestFirst",
  // or null when the list isn't sorted by finish time.
  function finishOrder(rows, sort) {
    if (sort && sort.column && sort.column !== "finishedAt") return null;
    const firstActive = rows.findIndex((r) => !r.finished);
    const firstFinished = rows.findIndex((r) => r.finished);
    if (firstActive !== -1 && firstFinished !== -1) {
      // Running auctions finish later than finished ones, so whichever group
      // comes first tells us the direction.
      return firstActive < firstFinished ? "newestFirst" : "oldestFirst";
    }
    if (sort) return sort.direction === "down" ? "newestFirst" : "oldestFirst";
    return null;
  }

  function parseSort(table) {
    for (const th of table.querySelectorAll("thead th")) {
      const arrow = th.querySelector(".sortingArrow");
      if (!arrow || arrow.classList.contains("inactive")) continue;
      const column = ["finishedAt", "price", "highestBidder", "bidCount", "itemInformation"].find((c) => th.classList.contains(c)) || null;
      return { column, direction: arrow.classList.contains("up") ? "up" : "down" };
    }
    return null;
  }

  const tables = [];
  for (const table of document.querySelectorAll("table.itemType")) {
    // Only tables that show a price and a highest bidder are auction lists
    // we can use (e.g. "Your bids"). "Sold items" has no buyer column.
    if (!table.querySelector("thead th.price") || !table.querySelector("thead th.highestBidder")) continue;
    const wrapper = table.closest(".auctionsOverviewContainer");
    const selectedPage = wrapper && wrapper.querySelector(".pagination .page.selected");
    const sort = parseSort(table);
    const rows = Array.from(table.querySelectorAll("tbody tr")).map(parseRow).filter(Boolean);
    // Running auctions are only used above to work out the order; they are
    // never returned or stored.
    const finishedRows = rows.filter((r) => r.finished).map(({ finished, ...r }) => r);
    tables.push({
      heading: text(wrapper && wrapper.querySelector(".listHeadline h4, h4.listHeadline")),
      sort,
      page: selectedPage ? int(selectedPage.getAttribute("title")) : null,
      order: finishOrder(rows, sort),
      skippedRunning: rows.length - finishedRows.length,
      rows: finishedRows,
    });
  }

  return {
    server: location.hostname,
    url: location.href,
    capturedAt: Date.now(),
    tables,
  };
})();
