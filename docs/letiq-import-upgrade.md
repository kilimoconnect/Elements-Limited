# Letiq ERP — Import, rebagging and transfer upgrade

Living record of the import / rebagging / branch-transfer upgrade: what is
implemented, the assumptions behind it, how to migrate, which checks were
actually run, and what remains. Updated at the end of every stage.

## Scope (from the business brief)

1. Import goods in bulk, capture purchase value / CIF and eligible acquisition
   costs, receive in bulk, rebag into 50 kg / 25 kg / 5 kg (configurable), store,
   transfer to branches and sell at the correct destination cost.
2. A rebagging order can produce several sizes and leave unused bulk. Bag
   counts, net kg and packaging materials are tracked separately.
3. Transfers capture loading, transport, offloading and other charges,
   driver / vehicle / transporter / agent details, attachments, delivery notes,
   dispatch, partial receipts and signed proof of delivery; sending and
   receiving branch users see the same in-transit transfer.
4. TZS is the functional and reporting currency. Foreign currency only for
   import-origin supplier invoices and their direct settlements, credits and
   balance adjustments. Payments to foreign suppliers record original currency
   settled and actual TZS debited. No foreign-currency bank ledgers.
5. Africa/Dar_es_Salaam, DD/MM/YYYY; existing product tax codes (no blanket 18%).

## Stage plan

| Stage | Content | Status |
| --- | --- | --- |
| 0 | Foundation: clean-install defaults fix, new system accounts, cost-category rules, currencies + exchange rates, kg base weight and product stock roles, PGlite test harness | **Done (this document, 21/10/2026)** |
| 1 | Import shipments: shipment header, foreign-currency CIF/FOB invoice with rate snapshot, explicit freight/insurance inclusion flags, acquisition cost lines (estimate → accrual → actual), bulk goods receipt in kg with GRNI / accrued-cost postings, landed-cost allocation, shipment/batch provenance on stock movements | Not started |
| 2 | Supplier side in foreign currency: import invoices through the existing supplier payables, settlements recording original currency + actual TZS debited, realised FX gain/loss, outstanding-balance revaluation, credits | Not started |
| 3 | Rebagging orders: consume bulk kg + packaging materials, produce several bag SKUs, leave unused bulk, conversion cost flow, normal vs abnormal loss | Not started |
| 4 | Transfer upgrade: charges (capitalised to receiving stock per cost category), transport details, Supabase Storage attachments with policies, delivery note, signed POD, partial receipt, shared in-transit view, goods-in-transit (1155) accounting | Not started |
| 5 | Later-cost propagation: late/actual costs reach stock still held (including rebagged and transferred stock) and cost of sales for sold portions; closed periods adjusted in the current open period | Not started |
| 6 | Commercial (pricing) cost view and import reports | Not started |

Each stage extends the existing posting services (`record_stock_movement`,
`create_journal`, `claim_idempotency`, `assert_period_open`, supplier
payables, transfers) rather than adding a parallel ERP.

---

## Stage 0 — Foundation (implemented)

### What was found in the repository

- 23 migrations, 109 permissions in 18 permission groups, 6 roles. Weighted
  average cost per (company, branch, product) in `stock_balances`; immutable
  `stock_movements`; idempotent, period-checked posting RPCs; transfers are
  single-company by construction (`stock_transfers.company_id`).
- **Clean-install defect:** migrations 0007, 0013 and 0019 added system accounts
  (3200, 4300, 4900, 6300, 1170, 5200, 5300, 1121, 1122, 1131, 1132), document
  sequences (inventory opening, supplier payment, financial opening) and
  control-account flags only to companies that existed when they ran. A fresh
  install (migrate → seed) lacked them, so opening stock, purchases and
  accounting openings failed. Confirmed on a clean PGlite database before the
  fix: all three integration suites failed (`No active document sequence for
  inventory_opening`, `Account 3200 is not configured`). The live database was
  backfilled by hand on 28/09/2026.
- No foreign currency, landed cost, accrual, batch, rebagging, kg weight or
  Supabase Storage usage existed yet.

### Migration `0024_import_foundation.sql`

- **`ensure_company_defaults(company)`** — one idempotent function that gives a
  company every system account, document sequence, weight unit and default cost
  category. Called for every existing company by the migration and by
  `scripts/seed.ts` for new installs. Later stages extend this function instead
  of adding one-off per-company loops. It **refuses** (raises) when a required
  code is already used by a different kind of account, rather than posting to
  the wrong account. It only repoints NMB/CRDB/M-Pesa/MIX payment accounts that
  still use the generic 1120/1130 header (never overrides a user's choice).
- **New system accounts** (per company):

  | Code | Account | Type | Control |
  | --- | --- | --- | --- |
  | 1155 | Goods in Transit (Branch Transfers) | asset | yes |
  | 1157 | Import Goods in Transit | asset | yes |
  | 2130 | Goods Received Not Invoiced | liability | yes |
  | 2140 | Accrued Import and Landed Costs | liability | yes |
  | 4400 | Realised Foreign Exchange Gain | revenue | |
  | 4410 | Unrealised Foreign Exchange Gain | revenue | |
  | 6150 | Storage and Warehousing | expense | |
  | 6400 | Realised Foreign Exchange Loss | expense | |
  | 6410 | Unrealised Foreign Exchange Loss | expense | |

  Abnormal inventory waste uses the existing 6300 Inventory Shrinkage / Loss.
- **`cost_categories`** — approved rules: capitalise vs expense (with expense
  account), allocation basis (net kg / value / quantity / manual), which
  workflows use it (import / transfer / rebagging), whether it appears in the
  commercial (pricing) view, and an optional *suggested* tax code. Validated in
  the database: expensed categories need a posting expense / cost-of-sales
  account; the goods-value category cannot be expensed; a category must apply
  to at least one workflow. 15 defaults are seeded (see Assumptions).
- **`currencies` + `exchange_rates`** — TZS is the single functional currency
  (`companies.base_currency` is now constrained to TZS). Rates are TZS per 1
  unit, `numeric(18,6)`, one per currency per day; TZS cannot have a rate.
  `exchange_rate_on(company, currency, date)` returns the latest rate on or
  before the date and **raises** if none exists (no silent default). Documents
  in later stages snapshot the rate they used.
- **kg base weight** — `units.kg_factor` (KG = 1, MT = 1000; other units stay
  blank). `products.stock_role` (`standard` default for every existing row,
  `bulk`, `packaged`, `packaging_material`), `products.net_weight_kg`,
  `products.bulk_product_id`. Database rules: bulk products use a kg-factor-1
  unit and always track stock (net kg forced to 1); packaged SKUs need net kg
  and a bulk source in the same company; standard products cannot reference a
  bulk product. Stock role, unit (for bulk/packaged) and net kg are **frozen
  once the product has stock movements**, so historic bag counts and kg totals
  keep their meaning. Existing products and units are not converted.
- **Security** — new tables use the 0005 model (read by company access, write
  Owner only) with forced RLS; currencies are readable by any signed-in user.
  `ensure_company_defaults`, the helper functions and `exchange_rate_on` are
  not executable by `anon` / `authenticated`.

### Application changes

- Admin → **Cost Categories** and **Exchange Rates** (Owner-only, generic
  admin engine, audit-logged like other master data).
- Admin → Products: Stock Role, Net kg per unit, Filled from bulk product; list
  shows Net kg. Admin → Units: Kg per unit.
- Generic admin engine: optional number-input `step`; nullable number fields
  now save blank as NULL (previously 0); option lists can use a column other
  than `code` (products use SKU).

### Test harness (new)

`npm run test:db` builds a throwaway **PGlite** 0.5.11 (in-process PostgreSQL 18.6)
database with stand-ins for Supabase's `auth.users`, `auth.uid()` and the
`anon` / `authenticated` / `service_role` roles, then runs:

1. migrate → seed → seed again (idempotency) → test owner,
2. the existing Phase 2 / 3 / 4 integration suites,
3. `scripts/itest-import0.ts` (Stage 0 checks),
4. `scripts/testdb/upgrade-check.ts`: rebuilds the database as the live one was
   created (migrations to 0023, pre-0024 seed, the same manual backfill),
   commits stock and journal activity, applies 0024, and compares trial
   balance, stock balances, movements, journal lines, accounts, payment-account
   ledgers and products before and after.

`DATABASE_URL` is blanked for every child process and the Stage 0 suite
refuses to run without `LETIQ_PGLITE_DIR`, so the harness cannot reach the live
project. Test hooks: `LETIQ_PGLITE_DIR` (scripts/db.ts), `LETIQ_MIGRATE_UNTIL`
(scripts/migrate.ts), `LETIQ_SEED_PRE_0024` (scripts/seed.ts).

### Checks actually run (21/10/2026)

| Check | Result |
| --- | --- |
| Baseline clean install **before** 0024 | Phase 2, 3, 4 suites **failed** (missing sequence / account 3200) — defect confirmed |
| `npm run test:db` — migrate, seed, seed re-run, test owner | pass |
| Phase 2 integration (existing) | 19 checks pass |
| Phase 3 integration (existing) | 26 checks pass |
| Phase 4 integration (existing) | 11 checks pass |
| Stage 0 suite (`itest-import0.ts`) | 51 checks pass |
| Upgrade path (`upgrade-check.ts`) | 13 checks pass |
| Mutation check: froze-after-movement rule removed temporarily | suite **failed** 2 checks as expected; rule restored |
| `npm test` (calculation unit tests) | 7 checks pass |
| `npm run typecheck` | pass |
| ESLint on changed files | pass (one pre-existing error in untouched `scripts/bootstrap-owner.ts`) |

**Not run:** the migration was **not** applied to the live Supabase project;
the Admin screens were not exercised in a browser (they need Supabase Auth,
which PGlite does not provide, and signing in to the live project is out of
bounds for these stages); RLS was tested under PGlite with the stub `auth.uid()`,
not under real Supabase JWTs. PGlite runs PostgreSQL 18.6, which may be newer
than the Supabase project's PostgreSQL major version; the migration uses no
version-specific features knowingly, but a staging run on Supabase remains the
definitive check.

### Assumptions (confirm or change)

- **Default capitalisation rules.** Capitalised: goods value, international
  freight, cargo insurance, customs duty and non-recoverable levies, port
  handling, clearing/agency, inspection/certification, inland transport,
  loading/offloading, branch-transfer transport, rebagging labour. Expensed:
  storage rent (6150), demurrage/detention (6100, treated as abnormal), bank
  charges (6200). All are editable under Admin → Cost Categories.
- Recoverable VAT is never a cost category; it stays on the tax code (input VAT
  1160). Default categories carry **no** tax code.
- Freight and insurance categories are used only when the goods value does not
  already include them; Stage 1 records inclusion explicitly on each shipment
  (e.g. CIF includes both, FOB neither) and blocks double entry.
- Seeded currencies: TZS (functional), USD, EUR, GBP, CNY, INR, AED, KES, ZAR.
- Rate convention: TZS per 1 unit of foreign currency.

### Migration instructions (live database — not yet done)

1. Back up the live database (Supabase backups / PITR, or `pg_dump`).
2. Pre-check that no custom account already uses a new code (the migration
   stops with a clear error if one does):

   ```sql
   select code, name, account_type from chart_of_accounts
   where code in ('1155','1157','2130','2140','4400','4410','6150','6400','6410');
   ```

   Expected: no rows (or only rows of the matching type).
3. Ideally apply first to a staging copy of the live database.
4. `npm run db:migrate` — applies only `0024_import_foundation.sql`.
5. Verify: 9 new accounts per company, 15 cost categories, KG unit has
   kg_factor 1, MT unit exists, trial balance unchanged.

### Limitations / remaining work after Stage 0

- Nothing uses cost categories, exchange rates or stock roles in a transaction
  yet; Stages 1–5 do.
- Admin "Treatment" / "Allocate by" columns show raw values (capitalize,
  net_weight).
- Admin → Document Numbering's type list does not yet label the inventory
  opening / supplier payment / financial opening sequences (pre-existing).
- Exchange-rate values pass through the generic admin form as JavaScript
  numbers; values up to 15 significant digits round-trip exactly, which covers
  `numeric(18,6)` rates in practice. Transaction amounts in later stages are
  computed in PostgreSQL `numeric`.
- Open design point for Stage 5 (late-cost propagation): needs per-shipment
  quantity tracking through receipts, rebagging and transfers while valuation
  stays weighted average. Proposed in Stage 1 via batch provenance on stock
  movements.
