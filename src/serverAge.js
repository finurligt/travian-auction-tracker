// Server age: which round of a game server an auction belongs to, and how
// many days into that round it was. The game page doesn't show when a
// server started, so rounds are entered by hand. A server keeps its address
// when it restarts, so each address has a list of rounds.
//
// db.serverRounds = { "<host>": { rounds: [{ start, end }], updatedAt } }
//
// Dates are "YYYY-MM-DD" (UTC). `end` is the last day of the round
// (inclusive), or null while it's running. A round without an end that is
// followed by another round ends where the next one starts.

const DAY = 86400000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// "ts1.x1.europe.travian.com" -> 1, "ts5.x3.international.travian.com" -> 3
export function serverSpeed(host) {
  const m = /(?:^|\.)x(\d+)\./i.exec(host || "");
  return m ? Number(m[1]) : null;
}

const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);

export function isDate(s) {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  // Rejects dates like 2026-02-31, which Date.parse would roll over.
  return new Date(dayStart(s)).toISOString().slice(0, 10) === s;
}

// Checks and sorts rounds entered by the user. Throws with a readable message.
export function validateRounds(rounds) {
  const cleaned = rounds
    .map((r) => ({ start: (r.start || "").trim(), end: (r.end || "").trim() || null }))
    .filter((r) => r.start || r.end);
  for (const r of cleaned) {
    if (!isDate(r.start)) throw new Error(r.start ? `"${r.start}" isn't a date like 2026-11-15` : "every round needs a start date");
    if (r.end !== null && !isDate(r.end)) throw new Error(`"${r.end}" isn't a date like 2026-11-15`);
    if (r.end !== null && r.end < r.start) throw new Error(`the round starting ${r.start} ends before it starts`);
  }
  cleaned.sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1];
    if (prev.start === cleaned[i].start || (prev.end !== null && prev.end >= cleaned[i].start)) {
      throw new Error(`the rounds starting ${prev.start} and ${cleaned[i].start} overlap`);
    }
  }
  return cleaned;
}

// The round an auction at time t belongs to, its day number (the start day
// is day 1) and the server speed, or null if t isn't inside any round.
export function serverAge(serverRounds, host, t) {
  const rounds = serverRounds?.[host]?.rounds || [];
  for (let i = 0; i < rounds.length; i++) {
    const { start, end } = rounds[i];
    const from = dayStart(start);
    const next = rounds[i + 1];
    const until = end !== null ? dayStart(end) + DAY : next ? dayStart(next.start) : Infinity;
    if (t >= from && t < until) {
      return { round: start, day: Math.floor((t - from) / DAY) + 1, speed: serverSpeed(host) };
    }
  }
  return null;
}

// Keeps whichever side changed last, per server.
export function mergeServerRounds(a = {}, b = {}) {
  const merged = { ...a };
  for (const [host, entry] of Object.entries(b)) {
    if (!merged[host] || entry.updatedAt > merged[host].updatedAt) merged[host] = entry;
  }
  return merged;
}
