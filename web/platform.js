// Web version of src/platform.js (see scripts/build-web.js): reads the
// de-duplicated auctions from the server. Read-only; capturing and editing
// happen in the extension.
import { emptyDb } from "./dedup.js";

export const readOnly = true;

const TOKEN_KEY = "auctionTrackerToken";
let memoryToken = null;

export class LoginRequired extends Error {}

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token) {
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode: keep it for this visit only.
  }
}

export function logout() {
  memoryToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

export async function loadDb() {
  const token = getToken();
  if (!token) throw new LoginRequired("");
  let response;
  try {
    response = await fetch("/api/auctions", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  } catch {
    throw new Error("Can't reach the server.");
  }
  if (response.status === 401) {
    logout();
    throw new LoginRequired("Wrong token.");
  }
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  const { auctions, captureCount } = await response.json();
  return { ...emptyDb(), auctions, captureCount };
}

export async function saveDb() {}
export async function loadSync() {
  return {};
}
export async function saveSync() {}
export async function requestSync() {
  return { ok: true, skipped: true };
}
export const isConfigured = () => false;
export function onDbChanged() {}
