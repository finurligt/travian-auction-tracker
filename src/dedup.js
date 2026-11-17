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
// Page breaks move as new auctions finish, so the first and last row of a
// page are seen with only one neighbour. An unknown neighbour never
// conflicts. Matching rule: a row is the same auction as a stored one when
// the signatures are equal and no neighbour known on both sides differs.
//
// Auctions are always rebuilt from all raw captures, processing the rows
// with the most context first (both neighbours known, then one, then none).
// That way an edge row can't claim the wrong auction just because its
// capture happened to be taken first.

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

// One observation per finished row in a capture, with its neighbours.
function observations(capture) {
  const result = [];
  for (const table of capture.tables) {
    const ordered = orderNewestFirst(table);
    const rows = ordered || table.rows;
    // The newest finished row's newer neighbour was a running auction (or is
    // off-page), so it sits at the edge here and stays unknown.
    const sigs = rows.map((r) => signature(r, capture.server));
    rows.forEach((row, i) => {
      const newer = ordered && i > 0 ? sigs[i - 1] : null;
      const older = ordered && i < rows.length - 1 ? sigs[i + 1] : null;
      result.push({
        captureId: capture.id,
        server: capture.server,
        at: capture.capturedAt,
        row,
        sig: sigs[i],
        newer,
        older,
        known: (newer !== null) + (older !== null),
      });
    });
  }
  return result;
}

function conflicts(a, b) {
  return a !== null && b !== null && a !== b;
}

function agreement(stored, obs) {
  return (stored.newer !== null && stored.newer === obs.newer ? 1 : 0) + (stored.older !== null && stored.older === obs.older ? 1 : 0);
}

let idCounter = 0;
function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `a${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export function buildAuctions(captures) {
  const all = captures.flatMap(observations);
  all.sort((a, b) => b.known - a.known || a.at - b.at);

  const auctions = [];
  const bySig = new Map();
  // A capture shows each auction at most once, so two rows of the same
  // capture can never be the same auction.
  const usedBy = new Map();

  for (const obs of all) {
    const candidates = (bySig.get(obs.sig) || []).filter(
      (a) => !usedBy.get(a).has(obs.captureId) && !conflicts(a.newer, obs.newer) && !conflicts(a.older, obs.older),
    );
    candidates.sort((a, b) => agreement(b, obs) - agreement(a, obs) || a.firstSeenAt - b.firstSeenAt);
    let auction = candidates[0];

    if (auction) {
      auction.newer ??= obs.newer;
      auction.older ??= obs.older;
      auction.firstSeenAt = Math.min(auction.firstSeenAt, obs.at);
      auction.lastSeenAt = Math.max(auction.lastSeenAt, obs.at);
      auction.seenCount += 1;
    } else {
      const r = obs.row;
      auction = {
        id: newId(),
        sig: obs.sig,
        server: obs.server,
        itemTypeId: r.itemTypeId,
        itemName: r.itemName,
        quantity: r.quantity,
        price: r.price,
        unitPrice: r.quantity ? r.price / r.quantity : r.price,
        bidderRaw: r.bidderRaw,
        bidder: r.bidder,
        alliance: r.alliance,
        bids: r.bids,
        newer: obs.newer,
        older: obs.older,
        // First time we saw it finished: the page shows no finish time, so
        // this is the best timestamp we have (an upper bound).
        firstSeenAt: obs.at,
        lastSeenAt: obs.at,
        seenCount: 1,
      };
      auctions.push(auction);
      usedBy.set(auction, new Set());
      if (!bySig.has(obs.sig)) bySig.set(obs.sig, []);
      bySig.get(obs.sig).push(auction);
    }
    usedBy.get(auction).add(obs.captureId);
  }
  return auctions;
}

// Adds a capture to db (mutating it) and recomputes all auctions.
// Returns a summary of what this capture contributed.
export function applyCapture(db, capture) {
  const before = db.auctions.length;
  db.captures.push(capture);
  db.auctions = buildAuctions(db.captures);
  const finished = capture.tables.reduce((n, t) => n + t.rows.length, 0);
  const added = Math.max(0, db.auctions.length - before);
  return {
    finished,
    added,
    duplicates: finished - added,
    skippedRunning: capture.tables.reduce((n, t) => n + (t.skippedRunning || 0), 0),
    unordered: capture.tables.some((t) => t.rows.length && !orderNewestFirst(t)),
  };
}

// Rebuilds all auctions from the stored raw captures. Used after importing,
// deleting a capture, or if the matching logic is improved later.
export function rebuild(db) {
  return { ...db, auctions: buildAuctions(db.captures) };
}
