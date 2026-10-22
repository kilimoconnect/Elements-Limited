/**
 * Read-only snapshot for the deployment runbook: a reconciliation baseline
 * (migrations, account-code pre-check, trial balance, stock vs 1150,
 * transfers, document counts) and, with "before", a JSON export of every
 * public table. One read-only transaction; prints no connection details.
 *
 * Usage: npm run db:snapshot -- before | after   (DATABASE_URL from .env.local)
 * Output: LETIQ_BACKUP_DIR or ~/letiq-backups — keep it out of the repo.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDbClient } from "./db";

const label = process.argv[2] ?? "before";
const outRoot = process.env.LETIQ_BACKUP_DIR || join(homedir(), "letiq-backups");

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin transaction isolation level repeatable read read only");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report: Record<string, unknown> = { label, at: new Date().toISOString() };
  try {
    report.migrations = (await db.query("select name from schema_migrations order by name")).rows.map((r) => r.name);
    report.companies = (await db.query("select code, base_currency from companies order by code")).rows;
    report.accountCodeCheck = (await db.query(`select c.code co, a.code, a.name, a.account_type from chart_of_accounts a join companies c on c.id=a.company_id
      where a.code in ('1121','1122','1131','1132','1145','1155','1157','1170','1175','2130','2140','4400','4410','6150','6300','6400','6410') order by 1,2`)).rows;
    report.trialBalance = (await db.query(`select c.code co, a.code, round(sum(l.debit),2) debit, round(sum(l.credit),2) credit
      from journal_lines l join journal_entries j on j.id=l.journal_id join chart_of_accounts a on a.id=l.account_id join companies c on c.id=j.company_id
      group by 1,2 order by 1,2`)).rows;
    report.tbNet = (await db.query("select coalesce(sum(debit-credit),0) net from journal_lines")).rows[0].net;
    report.stock = (await db.query(`select c.code co, count(*) rows, round(sum(quantity),4) qty, round(sum(stock_value),2) value
      from stock_balances b join companies c on c.id=b.company_id group by 1 order by 1`)).rows;
    report.gl1150 = (await db.query(`select c.code co, round(sum(l.debit-l.credit),2) v from journal_lines l join journal_entries j on j.id=l.journal_id
      join chart_of_accounts a on a.id=l.account_id join companies c on c.id=j.company_id where a.code='1150' group by 1`)).rows;
    report.openTransfers = (await db.query("select status, count(*) n from stock_transfers group by 1 order by 1")).rows;
    report.docCounts = (await db.query(`select 'sales' t, document_status, count(*) n from sales group by 2
      union all select 'purchases', document_status, count(*) from purchases group by 2
      union all select 'expenses', document_status, count(*) from expenses group by 2 order by 1,2`)).rows;

    if (label === "before") {
      const dir = join(outRoot, `prod-${stamp}`);
      mkdirSync(dir, { recursive: true });
      const tables = (await db.query(`select tablename from pg_tables where schemaname='public' order by 1`)).rows.map((r) => r.tablename as string);
      const counts: Record<string, number> = {};
      for (const t of tables) {
        const { rows } = await db.query(`select * from public."${t}"`);
        writeFileSync(join(dir, `${t}.json`), JSON.stringify(rows));
        counts[t] = rows.length;
      }
      writeFileSync(join(dir, "_manifest.json"), JSON.stringify({ at: report.at, migrations: report.migrations, counts }, null, 1));
      report.backupDir = dir;
      report.backupTables = tables.length;
      report.backupRows = Object.values(counts).reduce((a, b) => a + b, 0);
    }
  } finally {
    await db.query("rollback");
    await db.end();
  }
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, `baseline-${label}-${stamp}.json`), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, trialBalance: `${(report.trialBalance as unknown[]).length} account rows` }, null, 1));
}
main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
