// HTTP API.
//
//   GET  /api/captures?after=<seq>   captures added or deleted after <seq>
//   POST /api/captures               { add: [capture...], delete: [id...] }
//   GET  /api/auctions               de-duplicated auctions, for the web page
//   GET  /api/servers                rounds (start/end dates) per game server
//   POST /api/servers                { "<host>": { rounds: [{ start, end }], updatedAt } }
//
// Requests need "Authorization: Bearer <token>": SYNC_TOKEN for everything,
// or the optional read-only VIEW_TOKEN for /api/auctions.
import { createHash, timingSafeEqual } from "node:crypto";
import { buildAuctions } from "../../src/dedup.js";
import { validateRounds } from "../../src/serverAge.js";

export const PAGE_SIZE = 200;
const MAX_BATCH = 200;
const MAX_CAPTURE_BYTES = 200_000;

function authorized(header, ...tokens) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  // Hash both so the comparison is constant-time regardless of length.
  const digest = (s) => createHash("sha256").update(s).digest();
  const given = digest(m[1]);
  return tokens.some((token) => token && timingSafeEqual(given, digest(token)));
}

function setCommonHeaders(res, methods) {
  // The extension calls from a moz-extension:// origin. No cookies are
  // involved (the token is a header), so any origin is fine.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function validCapture(c) {
  return (
    c !== null &&
    typeof c === "object" &&
    typeof c.id === "string" &&
    c.id.length > 0 &&
    c.id.length <= 100 &&
    typeof c.server === "string" &&
    c.server.length <= 200 &&
    Number.isFinite(c.capturedAt) &&
    Array.isArray(c.tables) &&
    c.tables.every((t) => t && Array.isArray(t.rows)) &&
    JSON.stringify(c).length <= MAX_CAPTURE_BYTES
  );
}

const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 100;

export function createHandler({ store, token }) {
  return async function handler(req, res) {
    setCommonHeaders(res, "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (!authorized(req.headers.authorization, token)) return res.status(401).json({ error: "unauthorized" });

    try {
      if (req.method === "GET") {
        const after = Number(req.query.after ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "bad 'after'" });
        return res.status(200).json(await store.list(after, PAGE_SIZE));
      }

      if (req.method === "POST") {
        const body = req.body || {};
        const add = body.add ?? [];
        const del = body.delete ?? [];
        if (!Array.isArray(add) || !Array.isArray(del) || add.length + del.length > MAX_BATCH) {
          return res.status(400).json({ error: `send at most ${MAX_BATCH} captures per request` });
        }
        if (!add.every(validCapture)) return res.status(400).json({ error: "invalid capture" });
        if (!del.every(validId)) return res.status(400).json({ error: "invalid id" });
        const added = await store.add(add);
        const removed = await store.remove(del);
        return res.status(200).json({ added, removed });
      }

      return res.status(405).json({ error: "method not allowed" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "server error" });
    }
  };
}

// Only what the statistics page needs (no matching internals).
const PUBLIC_FIELDS = ["id", "server", "itemTypeId", "itemName", "quantity", "price", "unitPrice", "bidderRaw", "bidder", "alliance", "bids", "firstSeenAt"];

export function createAuctionsHandler({ store, token, viewToken }) {
  return async function handler(req, res) {
    setCommonHeaders(res, "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!authorized(req.headers.authorization, token, viewToken)) return res.status(401).json({ error: "unauthorized" });
    if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
    try {
      const [captures, serverRounds] = await Promise.all([store.all(), store.serverRounds()]);
      const auctions = buildAuctions(captures).map((a) => Object.fromEntries(PUBLIC_FIELDS.map((f) => [f, a[f]])));
      return res.status(200).json({ auctions, captureCount: captures.length, serverRounds });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "server error" });
    }
  };
}

// Same rules as the extension's form, and stored exactly as validated.
function validRounds(rounds) {
  if (!Array.isArray(rounds) || rounds.length > 100) return false;
  if (!rounds.every((r) => r && typeof r === "object" && Object.keys(r).length === 2 && "start" in r && "end" in r)) return false;
  try {
    return JSON.stringify(validateRounds(rounds)) === JSON.stringify(rounds);
  } catch {
    return false;
  }
}

function validServerRounds(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const entries = Object.entries(body);
  return (
    entries.length <= 100 &&
    entries.every(
      ([host, e]) =>
        host.length > 0 &&
        host.length <= 200 &&
        e &&
        validRounds(e.rounds) &&
        Number.isSafeInteger(e.updatedAt),
    )
  );
}

export function createServersHandler({ store, token }) {
  return async function handler(req, res) {
    setCommonHeaders(res, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!authorized(req.headers.authorization, token)) return res.status(401).json({ error: "unauthorized" });
    try {
      if (req.method === "POST") {
        if (!validServerRounds(req.body)) return res.status(400).json({ error: "invalid server rounds" });
        await store.saveServerRounds(req.body);
      } else if (req.method !== "GET") {
        return res.status(405).json({ error: "method not allowed" });
      }
      return res.status(200).json(await store.serverRounds());
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "server error" });
    }
  };
}
