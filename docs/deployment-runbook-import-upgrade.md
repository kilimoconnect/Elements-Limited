# Deployment runbook — import, rebagging & transfer upgrade

Release branch: `release/import-upgrade` (migrations `0024`–`0033`, Stages 0–9).
This runbook is for the person deploying; it contains **no credentials** and none
should be added to it. Do not run any step against production until the
prerequisites are complete and the release has been approved.

---

## 0. Prerequisites (blocking)

1. **Rotate credentials before release.** During setup, credentials for the
   production Supabase project (service-role key, database password) and the Owner's
   initial password were shared in plain text in a chat session. Treat them as
   exposed:
   - Supabase → Project Settings → API: roll the service-role (secret) key, and
     the anon / publishable key if you want a clean slate;
   - Supabase → Project Settings → Database: reset the database password;
   - have the Owner change their password after signing in;
   - update the environment variables below in Vercel (Production and Preview)
     and in any local `.env.local`; redeploy.
2. **Know the current production state.** `main` on GitHub (and therefore the
   live Vercel deployment, if it auto-deploys) already contains the Stage 0–4
   code, while the live database is at migration `0023`. Purchases and
   supplier payments in production are likely failing until migrations are
   applied (or the deployment is rolled back to `5a726d4`). Decide which first;
   this runbook assumes you will apply the migrations.
3. A **staging Supabase project** (separate project, separate keys) — needed
   for the signed-in browser walkthrough, which has **not** been done yet (see
   §3).
4. Approval of the business decisions in
   `docs/letiq-import-upgrade.md` → Stage 9 → "Assumptions needing business
   review".
5. A decision on the open stock-value defects D1 (voiding openings / stock-increase
   adjustments after the average moved) and D8 (UTC cut-offs on as-of reports): fix
   them first, or accept them in writing and follow the workaround in
   `docs/letiq-import-upgrade.md` → Stage 9 → Blockers.

### Configuration variable names (values are set in Vercel / `.env.local`, never here)

| Variable | Used by |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | app (browser and server) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app (browser and server) |
| `SUPABASE_SERVICE_ROLE_KEY` | server actions only — never exposed to the browser |
| `DATABASE_URL` | `npm run db:migrate`, `npm run db:seed` only |
| `OWNER_EMAIL`, `OWNER_INITIAL_PASSWORD` | Owner bootstrap script only |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_COMPANY_NAME` | display |

No new variables are introduced by this upgrade. Migration `0025` creates a
private Storage bucket `documents` (no public access; files are served through
short-lived signed links after server-side checks).

---

## 1. Before you start (production, read-only)

1. Announce a short posting freeze (no sales / purchases / payments while
   migrating; ~15 minutes).
2. **Back up.** Supabase → Database → Backups: confirm a recent backup / enable
   point-in-time recovery, and additionally take a logical dump with your own
   tooling (schema + data). Record the time.
3. **Record the reconciliation baseline** (keep screenshots or exports):
   - Reports → Trial Balance (as of today);
   - Reports → Inventory Valuation (total vs GL 1150);
   - Reports → Payables Ageing (total vs GL 2110) and Receivables Ageing;
   - number of open stock transfers in transit (Inventory → Stock Transfers).
4. **Account-code pre-check** — run read-only in the SQL editor:

   ```sql
   select code, name, account_type from chart_of_accounts
   where code in ('1121','1122','1131','1132','1145','1155','1157','1170','1175','2130','2140',
                  '4400','4410','6150','6300','6400','6410');
   ```

   Expected: no rows, or rows of the matching type. If a custom account already
   uses one of these codes with another type, stop: migration `0024` / `0025` will
   refuse with "Account code … is already used by a … account". Rename or renumber the
   custom account first.

---

## 2. Apply the migrations (production)

From the release branch, with `DATABASE_URL` pointing at production:

```bash
npm run db:migrate
```

`scripts/migrate.ts` applies only pending files, in order, each in its own
transaction, recording them in `schema_migrations`:
`0024_import_foundation` → `0025_import_foundations` → `0026_foreign_purchases`
→ `0027_import_shipments` → `0028_import_corrections` → `0029_rebagging` →
`0030_transfer_logistics` → `0031_cost_adjustments` → `0032_pricing_reports` →
`0033_release_hardening`.

Then register the new permissions and role grants and ensure company defaults:

```bash
npm run db:seed
```

(The seed is idempotent; it adds permissions such as `imports.*`,
`cost_invoices.*`, `rebagging.*`, `inventory.transfer_cost`,
`documents.view_licence` to the roles defined in `src/lib/auth/permissions.ts`,
and calls `ensure_company_defaults` for new accounts, cost categories,
currencies, account mappings and feature flags.)

**Checkpoint A — nothing moved.** Re-run the baseline reports from §1.3. The
trial balance, inventory value, payables and receivables must be identical. All
feature flags are OFF. Transfers that were in transit before the migration keep
the original behaviour and can still be received.

If a migration fails: it rolls back on its own; nothing after it is applied.
Fix forward (see §6) — do not edit an applied migration.

---

## 3. Deploy the application

1. Merge `release/import-upgrade` into `main` (pull request, review) — Vercel
   deploys production from `main`. Ensure the rotated keys are set first.
2. Smoke test as the Owner: sign in; open Sales, Purchases, Inventory, Kardex,
   Reports (P&L, Balance Sheet, Trial Balance), Cash & Banks reconciliation,
   Admin and Audit Log; post nothing yet.
3. **Signed-in walkthrough on staging first** (not yet done — required): apply
   the same migrations to the staging project, seed it, create test users for
   two branches and run the end-to-end scenario of
   `docs/user-guide-import-upgrade.md` through the screens (import → receipts
   → rebagging → transfer with delivery note → receipt with shortage →
   charges → sale → late invoice → payment). Compare the numbers with the
   automated scenario (`scripts/itest-scenario.ts`). Use test data only.

---

## 4. Feature activation (production, Admin → Feature Flags)

Switch on one at a time; after each, run **Reports → Cost Reconciliation**
(all checks must show OK) and Reports → Costing Exceptions.

1. `attachments` — upload one test document to an existing record, download it,
   confirm a user from another branch cannot.
2. `fx_settlement` — enter today's exchange rate (Admin → Exchange Rates).
3. `imports` — review Admin → Cost Categories (capitalised vs expensed,
   allocation basis) and Admin → Account Mappings with the accountant.
4. `rebagging` — set **Rebagging loss tolerance %** on each bulk product
   (Admin → Products; default 0 = every loss needs approval).
5. `transfer_logistics` — set **Transfer loss tolerance %** on products as
   agreed (Admin → Products; default 0); brief storekeepers on trips, delivery notes and receipts.

**Checkpoint B — first live documents.** After the first real shipment
receipt, rebagging and transfer: Cost Reconciliation all OK; Inventory
Valuation reconciled; Payables Ageing equals GL 2110.

---

## 5. Ongoing reconciliation checkpoints

- Daily for the first two weeks, then weekly: Reports → Cost Reconciliation and
  Costing Exceptions (overdue arrivals, open discrepancies, accruals > 30 days,
  unallocated charges).
- Before each period close: Cost Reconciliation all OK; open accruals (2140)
  and GR/IR (2130) items explained; stock in transit (1155) equals open trips;
  FX revaluation of open foreign invoices posted; then close the period.
- After a period is closed, late costs post in the open period and appear as
  catch-ups in Reports → Late Cost Adjustments.

---

## 6. Recovery — two separate things

### 6a. Application code (reversible)

- Vercel → Deployments → promote the previous deployment. This changes code
  only; the database stays on `0033`.
- The previous app versions were **not tested** against the new schema. If you
  roll back code, keep all new feature flags OFF and avoid purchases / supplier
  payments until the forward fix is deployed. Prefer a forward fix.

### 6b. Database and ledger (posted financial data)

- Migrations are additive and do not change existing balances. **Do not drop
  tables or delete rows created by the upgrade**, and never delete posted
  documents, stock movements, journals, cost history or audit records.
- **Before any new-workflow document has been posted** (all new flags still
  OFF): if the migration itself must be undone, restore the backup / PITR from
  §1.2 — this also discards any ordinary postings made since, so re-enter them
  from their source documents; coordinate with the accountant.
- **After live postings exist:** recover by forward fix only:
  - switch the affected feature flag OFF (stops new documents of that kind;
    posted ones remain valid and visible);
  - correct documents with their supported reversals: void goods invoice
    (unpaid), reverse cost invoice (unpaid), credit notes, cancel / void
    rebagging (while bags are unused), void transfer trip (nothing received),
    discrepancy resolutions, supplier price notes, reversal journals — each
    posts a linked, dated correction and keeps the original;
  - fix code or functions with a new migration (`0034_…`) — never by editing
    an applied migration;
  - re-run Cost Reconciliation and the baseline reports and record the result.

---

## 7. Sign-off record

| Step | By | Date | Result |
| --- | --- | --- | --- |
| Credentials rotated | | | |
| Backup taken / PITR confirmed | | | |
| Baseline reports recorded | | | |
| Migrations 0024–0033 applied; seed run | | | |
| Checkpoint A (balances unchanged) | | | |
| Staging signed-in walkthrough | | | |
| App deployed; smoke test | | | |
| Flags activated (one by one) with Cost Reconciliation OK | | | |
| Checkpoint B | | | |
