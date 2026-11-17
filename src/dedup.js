// Turns raw page captures into a de-duplicated list of finished auctions.
//
// The game exposes no auction id, so an auction is identified by its
// "signature" (server, item, quantity, price, buyer, bid count) plus its
// neighbours in the list. When the list is sorted by finish time, the order
// of finished auctions never changes: new auctions only appear at the top.
// So the finished auction directly newer and directly older than a given one
// stay the same across captures, which separates two genuinely different
// auctions that happen to share the same item, price, buyer and bid count.
//
// Matching rule: a captured row is the same auction as a stored one when the
// signatures are equal and no neighbour that is known on both sides differs.
// Unknown neighbours (page edges, a still-running neighbour, unsorted list)
// never conflict, and are filled in once a later capture reveals them.

export const DB_VERSION = 1;

export function emptyDb() {
  return { version: DB_VERSION, auctions: [], captures: [] };
}

export function signature(row, server) {
  return [server, row.itemTypeId ?? "", row.itemName, row.quantity, row.price, row.bidderRaw, row.bids].join("|");
}

// Returns rows ordered newest-finish first, or null if the order can't be trusted.
// Captures only contain finished auctions; running ones are dropped by the parser.
function orderNewestFirst(table) {
  if (table.order === "newestFirst") return table.rows;
  if (table.order === "oldestFirst") return [...table.rows].reverse();
  return null;
}

function conflicts(a, b) {
  return a !== null && b !== null && a !== b;
}

function agreement(stored, row) {
  return (stored.newer !== null && stored.newer === row.newer ? 1 : 0) + (stored.older !== null && stored.older === row.older ? 1 : 0);
}

let idCounter = 0;
function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `a${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

// Mutates db. Returns a summary of what happened.
export function applyCapture(db, capture) {
  const summary = { finished: 0, added: 0, duplicates: 0, skippedRunning: 0, unordered: false };
  const bySig = new Map();
  for (const a of db.auctions) {
    if (!bySig.has(a.sig)) bySig.set(a.sig, []);
    bySig.get(a.sig).push(a);
  }

  for (const table of capture.tables) {
    summary.skippedRunning += table.skippedRunning || 0;
    const ordered = orderNewestFirst(table);
    if (!ordered) summary.unordered = true;
    const rows = ordered || table.rows;

    // The newest finished row's newer neighbour was a running auction (or is
    // off-page), so it sits at the edge here and stays unknown.
    const sigs = rows.map((r) => signature(r, capture.server));
    const finished = [];
    rows.forEach((r, i) => {
      finished.push({
        row: r,
        sig: sigs[i],
        newer: ordered && i > 0 ? sigs[i - 1] : null,
        older: ordered && i < rows.length - 1 ? sigs[i + 1] : null,
      });
    });
    summary.finished += finished.length;

    // Rows with more known neighbours are the least ambiguous; match them first
    // so they don't lose their record to a vaguer row.
    finished.sort((x, y) => (y.newer !== null) + (y.older !== null) - ((x.newer !== null) + (x.older !== null)));

    const used = new Set();
    for (const f of finished) {
      const candidates = (bySig.get(f.sig) || []).filter(
        (a) => !used.has(a) && !conflicts(a.newer, f.newer) && !conflicts(a.older, f.older),
      );
      candidates.sort((a, b) => agreement(b, f) - agreement(a, f));
      const match = candidates[0];

      if (match) {
        used.add(match);
        match.newer ??= f.newer;
        match.older ??= f.older;
        match.lastSeenAt = Math.max(match.lastSeenAt, capture.capturedAt);
        match.firstSeenAt = Math.min(match.firstSeenAt, capture.capturedAt);
        match.seenCount += 1;
        summary.duplicates += 1;
      } else {
        const r = f.row;
        const auction = {
          id: newId(),
          sig: f.sig,
          server: capture.server,
          itemTypeId: r.itemTypeId,
          itemName: r.itemName,
          quantity: r.quantity,
          price: r.price,
          unitPrice: r.quantity ? r.price / r.quantity : r.price,
          bidderRaw: r.bidderRaw,
          bidder: r.bidder,
          alliance: r.alliance,
          bids: r.bids,
          newer: f.newer,
          older: f.older,
          // First time we saw it finished: an upper bound for its finish time.
          firstSeenAt: capture.capturedAt,
          lastSeenAt: capture.capturedAt,
          seenCount: 1,
        };
        db.auctions.push(auction);
        used.add(auction);
        if (!bySig.has(f.sig)) bySig.set(f.sig, []);
        bySig.get(f.sig).push(auction);
        summary.added += 1;
      }
    }
  }
  return summary;
}

// Rebuilds all auctions from the stored raw captures. Used after importing,
// deleting a capture, or if the matching logic is improved later.
export function rebuild(db) {
  const fresh = emptyDb();
  fresh.captures = [...db.captures].sort((a, b) => a.capturedAt - b.capturedAt);
  for (const c of fresh.captures) applyCapture(fresh, c);
  return fresh;
}
