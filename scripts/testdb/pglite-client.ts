/**
 * Minimal `pg.Client`-shaped adapter over PGlite (in-process PostgreSQL), so
 * the existing migrate / seed / integration scripts can run against a
 * throwaway database folder instead of the live Supabase project.
 *
 * Enabled by `LETIQ_PGLITE_DIR` (see scripts/db.ts). Only used by tests.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

/** Stand-ins for the Supabase objects the migrations reference. */
const SUPABASE_STUBS = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now(),
  email_confirmed_at timestamptz
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
`;

type QueryResult<R> = { rows: R[]; rowCount: number };

export class PGliteClient {
  private db: PGlite | null = null;

  constructor(private readonly dataDir: string) {}

  async connect(): Promise<void> {
    this.db = await PGlite.create(this.dataDir, {
      extensions: { pgcrypto, uuid_ossp, btree_gist },
      // Match node-postgres: numeric/bigint come back as strings so callers
      // keep doing their own decimal-safe parsing.
      parsers: { 1700: (v: string) => v, 20: (v: string) => v },
    });
    await this.db.exec(SUPABASE_STUBS);
  }

  async query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    if (!this.db) throw new Error("PGliteClient is not connected");
    if (params && params.length > 0) {
      const r = await this.db.query<R>(text, params);
      return { rows: r.rows, rowCount: r.rows.length || (r.affectedRows ?? 0) };
    }
    // node-postgres runs parameterless multi-statement text; PGlite needs exec.
    const results = await this.db.exec(text);
    const last = results[results.length - 1];
    const rows = (last?.rows ?? []) as R[];
    return { rows, rowCount: rows.length || (last?.affectedRows ?? 0) };
  }

  async end(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }
}
