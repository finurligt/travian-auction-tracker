// Stores raw captures. Captures never change once made, so syncing is just
// "add the ones you don't have". A deleted capture keeps a row (a tombstone)
// so other PCs learn about the deletion.
//
// Every insert or deletion takes the next value of capture_seq, and clients
// pull "everything after the last seq I saw".
//
// `query(text, params)` runs one SQL statement and resolves with its rows.

const SCHEMA = [
  "create sequence if not exists capture_seq",
  `create table if not exists captures (
    id text primary key,
    seq bigint not null default nextval('capture_seq'),
    server text,
    captured_at timestamptz,
    deleted boolean not null default false,
    data jsonb,
    received_at timestamptz not null default now()
  )`,
  "create index if not exists captures_seq_idx on captures (seq)",
  // Rounds (start and end dates) per game server, see src/serverAge.js.
  // The last edit wins.
  `create table if not exists server_rounds (
    host text primary key,
    rounds jsonb not null,
    updated_at bigint not null
  )`,
];

export function createStore(query) {
  let ready;
  const ensureSchema = () => {
    ready ??= (async () => {
      for (const statement of SCHEMA) await query(statement);
    })().catch((e) => {
      ready = undefined;
      throw e;
    });
    return ready;
  };

  return {
    async add(captures) {
      await ensureSchema();
      let added = 0;
      for (const c of captures) {
        const rows = await query(
          `insert into captures (id, server, captured_at, data)
           values ($1, $2, to_timestamp($3::float8 / 1000), $4::jsonb)
           on conflict (id) do nothing
           returning id`,
          [c.id, c.server, c.capturedAt, JSON.stringify(c)],
        );
        added += rows.length;
      }
      return added;
    },

    // Also records deletions of ids never uploaded, in case the upload
    // arrives later from another PC.
    async remove(ids) {
      await ensureSchema();
      let removed = 0;
      for (const id of ids) {
        const rows = await query(
          `insert into captures (id, deleted) values ($1, true)
           on conflict (id) do update set deleted = true, data = null, seq = nextval('capture_seq')
           where not captures.deleted
           returning id`,
          [id],
        );
        removed += rows.length;
      }
      return removed;
    },

    async serverRounds() {
      await ensureSchema();
      const rows = await query("select host, rounds, updated_at::text as updated_at from server_rounds");
      return Object.fromEntries(rows.map((r) => [r.host, { rounds: r.rounds, updatedAt: Number(r.updated_at) }]));
    },

    async saveServerRounds(entries) {
      await ensureSchema();
      for (const [host, { rounds, updatedAt }] of Object.entries(entries)) {
        await query(
          `insert into server_rounds (host, rounds, updated_at) values ($1, $2::jsonb, $3::bigint)
           on conflict (host) do update set rounds = excluded.rounds, updated_at = excluded.updated_at
           where excluded.updated_at > server_rounds.updated_at`,
          [host, JSON.stringify(rounds), updatedAt],
        );
      }
    },

    async all() {
      await ensureSchema();
      const rows = await query("select data from captures where not deleted order by captured_at");
      return rows.map((r) => r.data);
    },

    async list(after, limit) {
      await ensureSchema();
      const rows = await query(
        // Order by the column, not the text alias (which would sort "10" before "9").
        `select id, seq::text as seq_text, deleted, data from captures
         where seq > $1::bigint order by captures.seq limit $2::int`,
        [after, limit + 1],
      );
      const page = rows.slice(0, limit).map((r) => ({ id: r.id, seq: Number(r.seq_text), deleted: r.deleted, data: r.data }));
      return {
        captures: page,
        next: page.length ? page.at(-1).seq : after,
        more: rows.length > limit,
      };
    },
  };
}
