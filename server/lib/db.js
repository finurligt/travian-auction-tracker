import postgres from "postgres";

// Neon's pooled connection string (set by the Vercel ↔ Neon integration).
// The pooler doesn't keep prepared statements, so don't use them.
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { prepare: false, max: 1 }) : null;

export async function query(text, params = []) {
  if (!sql) throw new Error("DATABASE_URL is not set");
  return sql.unsafe(text, params);
}
