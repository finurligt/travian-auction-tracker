// The statistics page runs in two places: in the extension (this file: data
// in the extension's storage, editable, synced) and as a read-only web page
// served by the sync server, where web/platform.js replaces this file.
export { loadDb, loadSync, requestSync, saveDb, saveSync } from "./storage.js";
export { isConfigured } from "./sync.js";

export const readOnly = false;

export class LoginRequired extends Error {}
export function setToken() {}
export function logout() {}

export function onDbChanged(callback) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.db) callback(changes.db.newValue);
  });
}
