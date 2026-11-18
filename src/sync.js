// Syncs raw captures with the server (see server/). Captures never change,
// so this only uploads captures the server hasn't seen, sends pending
// deletions, and downloads what other PCs added or deleted since last time.
// Auctions are then rebuilt locally from the merged captures.
import { rebuild } from "./dedup.js";
import { mergeServerRounds } from "./serverAge.js";

const UPLOAD_BATCH = 50;
const DELETE_BATCH = 200;
const MAX_PAGES = 1000;

export function isConfigured(settings) {
  return Boolean(settings && settings.url && settings.token);
}

function client(settings, fetchImpl) {
  const base = settings.url.trim().replace(/\/+$/, "");
  return async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("can't reach the server");
    }
    if (response.status === 401) throw new Error("the server rejected the token");
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return response.json();
  };
}

// Talks to the server. Doesn't touch local storage: returns what to change,
// so the caller can apply it to a freshly loaded db (a capture may have been
// made while this was running).
export async function exchange(db, settings, fetchImpl = fetch) {
  const localCaptures = db.captures;
  const call = client(settings, fetchImpl);
  const synced = new Set(settings.synced || []);
  const pendingDeletes = settings.pendingDeletes || [];

  for (let i = 0; i < pendingDeletes.length; i += DELETE_BATCH) {
    await call("POST", "/api/captures", { delete: pendingDeletes.slice(i, i + DELETE_BATCH) });
  }

  const toUpload = localCaptures.filter((c) => !synced.has(c.id));
  for (let i = 0; i < toUpload.length; i += UPLOAD_BATCH) {
    const batch = toUpload.slice(i, i + UPLOAD_BATCH);
    await call("POST", "/api/captures", { add: batch });
    for (const c of batch) synced.add(c.id);
  }

  const incoming = new Map();
  const removed = new Set();
  let after = settings.lastSeq || 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call("GET", `/api/captures?after=${after}`);
    for (const c of result.captures) {
      if (c.deleted) {
        incoming.delete(c.id);
        removed.add(c.id);
        synced.delete(c.id);
      } else {
        incoming.set(c.id, c.data);
        removed.delete(c.id);
        synced.add(c.id);
      }
    }
    after = result.next;
    if (!result.more) break;
  }

  // Start dates are tiny: send them all, get back the merged set.
  const serverRounds = await call("POST", "/api/servers", db.serverRounds || {});

  return {
    serverRounds,
    incoming: [...incoming.values()],
    removed: [...removed],
    settings: {
      ...settings,
      synced: [...synced],
      pendingDeletes: [],
      lastSeq: after,
      lastSyncAt: Date.now(),
      lastError: null,
    },
    summary: { uploaded: toUpload.length, deletedRemotely: pendingDeletes.length },
  };
}

// Applies the result of exchange() to db. Returns the same db object if
// nothing changed.
export function applyExchange(db, result) {
  const removed = new Set(result.removed);
  const known = new Set(db.captures.map((c) => c.id));
  const added = result.incoming.filter((c) => !known.has(c.id));
  const kept = db.captures.filter((c) => !removed.has(c.id));
  const removedCount = db.captures.length - kept.length;
  result.summary.downloaded = added.length;
  result.summary.removedLocally = removedCount;
  const serverRounds = mergeServerRounds(db.serverRounds, result.serverRounds);
  const startsChanged = JSON.stringify(serverRounds) !== JSON.stringify(db.serverRounds || {});
  if (!added.length && !removedCount) return startsChanged ? { ...db, serverRounds } : db;
  return rebuild({ ...db, serverRounds, captures: [...kept, ...added] });
}
