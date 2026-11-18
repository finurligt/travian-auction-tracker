import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "../lib/handler.js";
import { createStore } from "../lib/store.js";

export const TOKEN = "test-token";

export async function memoryStore() {
  const pg = new PGlite();
  return createStore(async (text, params) => (await pg.query(text, params)).rows);
}

// Calls the handler the way Vercel does: parsed JSON body and query string.
export async function call(handler, { method = "GET", query = {}, body, token = TOKEN } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  await handler({ method, query, body, headers }, res);
  return res;
}

// A fetch() that goes straight to the handler, for sync tests.
export function fetchFor(handler) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const token = (init.headers?.Authorization || "").replace(/^Bearer /, "");
    const res = await call(handler, {
      method: init.method || "GET",
      query: Object.fromEntries(u.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined,
      token,
    });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.body };
  };
}

export async function server() {
  return createHandler({ store: await memoryStore(), token: TOKEN });
}

export const capture = (id, capturedAt = 1000, price = 100) => ({
  id,
  server: "ts1.x1.europe.travian.com",
  capturedAt,
  tables: [{ order: "newestFirst", skippedRunning: 0, rows: [
    { itemName: "Cage", itemTypeId: 114, quantity: 5, price, bidderRaw: "Helm (VOID)", bidder: "Helm", alliance: "VOID", bids: 8 },
  ] }],
});
