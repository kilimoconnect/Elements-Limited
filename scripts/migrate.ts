import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "./db";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

async function main() {
  const client = createDbClient();
  await client.connect();
  try {
    await client.query(`
      create table if not exists public.schema_migrations (
        name    text primary key,
        run_at  timestamptz not null default now()
      );
    `);

    const { rows } = await client.query<{ name: string }>(
      "select name from public.schema_migrations",
    );
    const applied = new Set(rows.map((r) => r.name));

    // Test hook: LETIQ_MIGRATE_UNTIL=0023 stops after that migration (used by
    // the upgrade-path check to rebuild a pre-upgrade database).
    const until = process.env.LETIQ_MIGRATE_UNTIL;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !until || f.slice(0, until.length) <= until)
      .sort();

    // LETIQ_MIGRATE_DRY_RUN=1: apply every pending migration inside ONE
    // transaction against the real data, report, then roll everything back.
    const dryRun = process.env.LETIQ_MIGRATE_DRY_RUN === "1";
    if (dryRun) {
      const pending = files.filter((f) => !applied.has(f));
      console.log(`DRY RUN: ${pending.length} pending migration(s); nothing will be kept.`);
      await client.query("begin");
      try {
        for (const file of pending) {
          process.stdout.write(`  ~ try    ${file} ... `);
          await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
          console.log("ok");
        }
        console.log("\nDry run succeeded. Rolling back.");
      } finally {
        await client.query("rollback");
      }
      return;
    }

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = skip   ${file}`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`  + apply  ${file} ... `);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into public.schema_migrations(name) values ($1)",
          [file],
        );
        await client.query("commit");
        ran += 1;
        console.log("done");
      } catch (err) {
        await client.query("rollback");
        console.log("FAILED");
        throw err;
      }
    }

    console.log(`\nMigrations complete. ${ran} applied, ${files.length - ran} skipped.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("\nMigration failed:\n", err);
  process.exit(1);
});
