import { config } from "dotenv";
import { Client } from "pg";

// Load .env.local (falls back to .env).
config({ path: ".env.local" });
config();

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local (Supabase > Project Settings > Database > Connection string).",
    );
  }
  return url;
}

export function createDbClient(): Client {
  // Tests: an in-process PGlite database folder instead of the real project.
  // Never falls through to DATABASE_URL when set.
  const pgliteDir = process.env.LETIQ_PGLITE_DIR;
  if (pgliteDir) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PGliteClient } = require("./testdb/pglite-client") as typeof import("./testdb/pglite-client");
    return new PGliteClient(pgliteDir) as unknown as Client;
  }
  return new Client({
    connectionString: requireDatabaseUrl(),
    // Supabase requires TLS; the pooled/direct hosts use certs Node may not
    // have in its trust store, so relax verification for this admin script.
    ssl: { rejectUnauthorized: false },
  });
}
