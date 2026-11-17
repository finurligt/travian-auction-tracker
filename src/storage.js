// All data lives in the extension's own local storage (never on the game's
// site). Swap these two functions to sync with a remote database later.
import { emptyDb } from "./dedup.js";

export async function loadDb() {
  const { db } = await browser.storage.local.get("db");
  return db || emptyDb();
}

export async function saveDb(db) {
  await browser.storage.local.set({ db });
}
