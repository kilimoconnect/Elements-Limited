/**
 * `npm run test:db` — builds a fresh throwaway PGlite database and runs the
 * full clean-install path plus every integration suite against it:
 *
 *   migrate -> seed -> test owner -> itest (P2) -> itest3 (P3) -> itest4 (P4)
 *   -> any extra suites listed in SUITES
 *
 * plus the upgrade-path check (scripts/testdb/upgrade-check.ts), which
 * simulates a database created before the newest migrations.
 *
 * DATABASE_URL is blanked for every child process, so nothing here can reach
 * the live Supabase project.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STEPS: [string, string][] = [
  ["migrate", "scripts/migrate.ts"],
  ["seed", "scripts/seed.ts"],
  ["seed (re-run, must be idempotent)", "scripts/seed.ts"],
  ["test owner", "scripts/testdb/test-owner.ts"],
  ["Phase 2 integration", "scripts/itest.ts"],
  ["Phase 3 integration", "scripts/itest3.ts"],
  ["Phase 4 integration", "scripts/itest4.ts"],
  ["Import foundation (Stage 0)", "scripts/itest-import0.ts"],
  ["Import foundations and secure posting (Stage 2)", "scripts/itest-import2.ts"],
  ["Foreign purchases with TZS books (Stage 3)", "scripts/itest-import3.ts"],
  ["Import shipments and landed cost (Stage 4)", "scripts/itest-import4.ts"],
  ["Bulk-to-bag rebagging (Stage 5)", "scripts/itest-import5.ts"],
  ["Transfer costs and dispatch file (Stage 6)", "scripts/itest-import6.ts"],
  ["Late costs, corrections and close (Stage 7)", "scripts/itest-import7.ts"],
  ["Pricing and operational reports (Stage 8)", "scripts/itest-import8.ts"],
  ["End-to-end scenario (Stage 9)", "scripts/itest-scenario.ts"],
  ["Negative cases and regression (Stage 9)", "scripts/itest-negative.ts"],
  ["Valuation fixes D1 / D8", "scripts/itest-valuation.ts"],
  ["Sales order approval", "scripts/itest-sales-approval.ts"],
  ["Sales promotions", "scripts/itest-promotions.ts"],
];

function run(label: string, script: string, env: NodeJS.ProcessEnv): boolean {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), script], {
    stdio: "inherit",
    env,
  });
  if (r.status !== 0) console.error(`*** ${label} FAILED (exit ${r.status})`);
  return r.status === 0;
}

const only = process.argv.slice(2);
const results: [string, boolean][] = [];

// 1) Clean install.
const dir = mkdtempSync(join(tmpdir(), "letiq-pglite-"));
const env = { ...process.env, LETIQ_PGLITE_DIR: dir, DATABASE_URL: "" };
for (const [label, script] of STEPS) {
  if (only.length && !only.some((o) => label.toLowerCase().includes(o.toLowerCase()))) continue;
  const ok = run(label, script, env);
  results.push([label, ok]);
  if (!ok && results.length <= 4) break; // setup failed: later suites are meaningless
}
rmSync(dir, { recursive: true, force: true });

// 2) Upgrade path (separate fresh database).
if (!only.length || only.some((o) => "upgrade".includes(o.toLowerCase()))) {
  const udir = mkdtempSync(join(tmpdir(), "letiq-pglite-up-"));
  results.push(["Upgrade path", run("Upgrade path", "scripts/testdb/upgrade-check.ts",
    { ...process.env, LETIQ_PGLITE_DIR: udir, DATABASE_URL: "" })]);
  rmSync(udir, { recursive: true, force: true });
}

console.log("\n=== Summary ===");
for (const [label, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
