// Runs syncs for the popup and the statistics page, one at a time, so the
// popup closing mid-sync doesn't cut it off.
import { loadDb, loadSync, saveDb, saveSync } from "../src/storage.js";
import { applyExchange, exchange, isConfigured } from "../src/sync.js";

let running = null;

async function runSync() {
  const settings = await loadSync();
  if (!isConfigured(settings)) return { ok: true, skipped: true };
  try {
    const result = await exchange((await loadDb()).captures, settings);
    const latest = await loadSync();
    // Settings changed to another server meanwhile: drop this result.
    if (latest.url !== settings.url || latest.token !== settings.token) return runSync();
    // Reload right before saving: a capture may have been made meanwhile.
    const db = await loadDb();
    const next = applyExchange(db, result);
    if (next !== db) await saveDb(next);
    // Keep deletions made while the sync was running.
    const stillPending = (latest.pendingDeletes || []).filter((id) => !(settings.pendingDeletes || []).includes(id));
    await saveSync({ ...result.settings, url: latest.url, token: latest.token, pendingDeletes: stillPending });
    return { ok: true, ...result.summary };
  } catch (e) {
    await saveSync({ ...(await loadSync()), lastError: e.message });
    return { ok: false, error: e.message };
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "sync") return undefined;
  running ??= runSync().finally(() => {
    running = null;
  });
  return running;
});
