// All data lives in the extension's own local storage (never on the game's
// site). The optional sync server (see server/) gets a copy of the captures.
import { emptyDb } from "./dedup.js";

export async function loadDb() {
  const { db } = await browser.storage.local.get("db");
  return db || emptyDb();
}

export async function saveDb(db) {
  await browser.storage.local.set({ db });
}

// Sync settings and state, kept apart from the data so exports never
// contain the token.
export async function loadSync() {
  const { sync } = await browser.storage.local.get("sync");
  return sync || { url: "", token: "", lastSeq: 0, synced: [], pendingDeletes: [] };
}

export async function saveSync(sync) {
  await browser.storage.local.set({ sync });
}

// Asks the background page to sync. Resolves with { ok, ... } and never
// throws, so a failed sync never breaks a capture (it's saved locally first).
export async function requestSync() {
  try {
    return await browser.runtime.sendMessage({ type: "sync" });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
