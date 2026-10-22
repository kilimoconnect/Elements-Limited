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
| 0 | Foundation: clean-install defaults fix, new system accounts, cost-category rules, currencies + exchange rates, kg base weight and product stock roles, PGlite test harness | **Done 21/10/2026** (record below) |
| 1 | Investigation of the actual code + integrated design (this section) | **Done 21/10/2026** — documentation only, no behaviour change |
| 2 | Shared foundations and secure posting primitives (schema, allocation engine, actor checks, idempotency, registry, account mappings, feature flags, attachments) | **Done 21/10/2026** (record below) |
| 2b | Remaining hardening from Stage 1: fix void/transfer subledger drift (D1, D2, D5), goods-in-transit 1155 on transfers, branch enforcement in the existing transfer actions (D3), caller-supplied idempotency keys in existing server actions (D4), lot maintenance with an "untracked" lot for existing stock | Partly: D2, D3 and D4 for transfers fixed in Stage 6; D1 (openings / adjustments), D5 and D4 elsewhere still open |
| 3 | Foreign purchases with TZS books: foreign purchase invoices, foreign supplier balances (original currency + TZS carrying), settlements through TZS accounts with realised FX, advances, bank charges, period-end revaluation, foreign returns and credits, currency confinement | **Done 21/10/2026** (record below) |
| 4 | Import shipments: shipment + lines, title (ownership) event, goods invoice via `purchases` invoice-only mode, GR/IR clearing, cost sources (estimate → accrual → actual) and `cost_invoices`, allocations, goods receipt (GRN) with discrepancy resolution, late-cost propagation for import lots | **Done 21/10/2026** (record below; screens not yet walked through in a browser) |
| 5 | Rebagging orders (multi-size outputs, packaging materials, normal/abnormal loss, unused bulk) + propagation through conversion | **Done 22/10/2026** (record below; screens not yet run in a browser) |
| 6 | Transfer upgrade: logistics details, charges, Storage attachments, versioned delivery notes, partial receipts with signed POD, discrepancy approval, shared in-transit view + propagation through transfers | **Done 22/10/2026** (record below; screens not yet run in a browser) |
| 7 | Late costs, corrections and accounting close (cost-delta algorithm across imports, purchases, rebagging, transfers; reconciliation) | **Done 22/10/2026** (record below; screens not yet run in a browser) |
| 8 | Pricing (accounting vs commercial cost, markup / margin, VAT) and costing / operations reports | **Done 22/10/2026** (record below; screens not yet run in a browser) |
| 9 | Integrated verification and release preparation (tests, scenario, hardening, runbook, release notes, user guide) | **Done 22/10/2026** — release candidate; **not production-ready** until the Stage 9 blockers are cleared |

Each stage extends the existing posting services (`record_stock_movement`,
`create_journal`, `claim_idempotency`, `assert_period_open`, supplier
payables, transfers) rather than adding a parallel ERP.

---

## Stage 9 — Integrated verification and release preparation

Branch `release/import-upgrade`, not pushed, not deployed. Migration
`0033_release_hardening.sql` (additive). Release documents:
`docs/release-notes-import-upgrade.md`,
`docs/deployment-runbook-import-upgrade.md`,
`docs/user-guide-import-upgrade.md`. The README was updated: no
implemented feature is described as deferred any more.

### Changes made in this stage

- **0033**:
  - indexes for realistic volumes (cost replay over `stock_movements`, journals
    by source, trip, receipt, rebagging, lot, allocation and document
    lookups);
  - `account_mappings.created_by`;
  - execute on every trigger function revoked from `public`, `anon` and
    `authenticated`;
  - **cross-company guards on the pre-upgrade transaction tables**, through
    `check_company_consistency` on the headers and the new
    `check_line_company()` on the lines.
- **Finding fixed.** Before 0033, a crafted insert could attach another
  company's supplier, customer, product, account or branch to a sale,
  purchase, return, expense, payment, adjustment, opening, other income or
  journal. The upgrade's own tables already had such guards; the older tables
  did not.
- App:
  - delivery note "Dispatch date" printed in DD/MM/YYYY;
  - Admin → Account Mappings screen;
  - **Transfer loss tolerance %** field on products (the column existed but
    could not be edited);
  - purchase draft checks the supplier's company.
- Tests: `scripts/itest-scenario.ts` (end-to-end scenario) and
  `scripts/itest-negative.ts` (negative and regression cases), both registered
  in `npm run test:db`.
- Tooling: `scripts/start-offline.mjs` runs the built app with Supabase
  pointed at an unused local address, so UI checks can never reach a real
  project.

### Checks actually run (final run, 22/10/2026, after all edits)

| Check | Result |
| --- | --- |
| `npm run lint` | **fails: 11 errors, 9 warnings, all in files last changed before the upgrade** (Phase 1–4: `bootstrap-owner.ts`, roles manager, cash account page, balance sheet, receipt form, app shell, confirm dialog, `reports/queries.ts` — React-compiler `set-state-in-effect` / components-in-render, `no-explicit-any`, `prefer-const`). No lint error in upgrade code. Left unchanged to avoid touching unrelated screens; fix in a separate change. |
| `npm run typecheck` | pass (0 errors) |
| `npm test` (tax / weighted average, attachment policy, pricing) | pass (incl. 13 pricing checks) |
| `npm run test:db`: clean install (all migrations + seed) on PGlite, then phase 2–4 suites, Stage 0–8 suites, scenario, negative suite, upgrade-from-existing-data check | **pass** — 19 + 26 + 11 (Phases 2–4), 51 + 114 + 79 + 58 + 50 + 59 + 47 + 17 (Stages 0, 2–8), 30 scenario, 50 negative = 611 checks; upgrade path 22 checks (existing data migrated 0023 → 0033 with unchanged balances) |
| `npm run build` (dummy env overrides, no real project) | pass — compiled successfully (WASM fallback: the native SWC binary in this Dropbox folder is unreadable; environment issue only) |
| Browser, unauthenticated, at `localhost:3100`: every new route (imports, cost invoices, rebagging, transfers and trips, pricing, supplier credits, 8 new reports, admin screens, delivery-note PDF API) redirects to sign-in; sign-in page has no console errors and no horizontal scroll at 375 px | pass |
| Delivery-note PDF generated by the scenario and inspected visually (header, trip, driver / vehicle, lines, signature blocks, version) | pass |

### End-to-end scenario (`itest-scenario.ts`, 30 checks, all pass)

1. **USD goods of 32,000.** Ownership taken at 2,500 (80M) and invoiced at
   2,520, so AP is USD 32,000 / TZS 80.64M, and +640k goes to goods in
   transit.
2. **Provisional import costs.** Accruals of 6M + 4M are approved explicitly
   (Cr 2140). Goods in transit (1157) stand at 90.64M.
3. **Partial bulk receipts and the actual clearing invoice.**
   - The first receipt of 60,000 kg takes 60 % of the value (54,384,000).
   - The clearing invoice is 4.5M against a 4M accrual, so only +500k posts:
     300k to stock received and 200k to stock still in transit.
   - The final receipt makes 100,000 kg at 911.40/kg (91,140,000). 1157 and
     GR/IR are cleared.
4. **Rebagging.** 50,000 kg becomes 500 × 50 kg, 600 × 25 kg and 2,000 × 5 kg
   bags, using packaging from stock and labour. Cost per bag is
   46,470 / 23,385 / 4,857.
5. **Dispatch.**
   - A duplicate dispatch request posts once.
   - The licence document is restricted (the storekeeper is refused it).
   - Delivery note v1 shows the driver, agent and signature spaces, with no
     licence number and no cost.
   - 1155 holds 19,388,000: 400 bags plus 800k of accrued transport.
6. **Shared in-transit view.** The sender and the receiver see the same
   cargo; an unrelated branch sees nothing.
7. **Receipt.** 380 bags are accepted at 48,470, and 10 quarantined + 10
   short are held. A duplicate receipt request returns the same receipt.
   Offloading of 200k splits 190k to the bags received and 10k to the bags
   held.
8. **Discrepancies.** A storekeeper cannot approve losses. 10 damaged bags
   are written off (489,700 to 6300) and 10 short bags are claimed (489,700
   to 1145).
9. **Sale.** 200 bags sold at Mwanza: cost of sales 9,794,000.
10. **Late transport invoice.** 900k against the 800k accrual gives +100k,
    split 45k (held), 50k (sold) and 5k (lost).
11. **Settlement.** USD 16,000 paid with TZS 40.8M: FX loss 480,000.
12. **Period close.** June is closed and nothing posts into it. A July credit
    note of 50k splits −22,500 (held), −25,000 (cost of sales, reported as a
    catch-up) and −2,500 (loss).

Reconciliation (R1–R9):
- Mwanza holds 180 bags at 8,837,100.
- GL 1150 equals the stock subledger.
- 1155, 1157 and 2130 are all 0.
- 2140 is 6,310,000 (port 6M awaiting invoice, labour 310k).
- 2110 is 45,870,000.
- 6400 is 480,000, 6300 is 492,200 and 1145 is 489,700.
- Cost of sales is 9,819,000.
- All 13 reconciliation checks pass, and the trial balance balances.

### Negative and regression cases (`itest-negative.ts`, 50 checks, all pass)

- **Security:**
  - no `security definer` or trigger function is callable by anon or
    authenticated, except the RLS self-checks;
  - every app-writable table has RLS, and the only write policies are the
    Owner-only master-data ones (0005);
  - a Director cannot write master data, and an anonymous caller reads
    nothing.
- **Isolation:**
  - guessed cross-company references are rejected on headers and lines
    (purchase, sale, journal lines and others);
  - a storekeeper of another branch cannot act on this branch.
- **Currency:** foreign currency is confined to purchase-origin documents,
  and a foreign cost invoice is rejected.
- **Quantities:**
  - pack kg must equal bags × pack weight;
  - fractional bags are rejected;
  - a bulk product cannot be an output;
  - packaged bags cannot be imported;
  - overselling and over-dispatch are refused;
  - two orders competing for the same 1,000 kg: the second is refused, and
    stock never goes negative;
  - a completed order cannot be completed again.
- **Allocation:**
  - manual allocations must add up to the total and percentages to 100 %;
  - duplicate targets are rejected;
  - rounding is exact (100 over 3 targets gives 33.34 / 33.33 / 33.33).
- **Immutability:**
  - journal lines, stock movements, completed rebag lines, cost-delta
    evidence and the audit log cannot be changed;
  - rebag status cannot be set directly.
- **Periods:** rebagging and ordinary sales are refused in a locked period.
- **Voids:** voids with dependants are refused (rebag with sold bags, a
  transfer with received cargo), and a duplicate receipt beyond the dispatched
  quantity is refused.
- **Regression:** stock adjustment with Kardex consistency, bank
  reconciliation adjustment, the trial balance across all postings, Cost
  Reconciliation on this data, the indexes exist, and account mappings can be
  created from Admin.

Idempotent retries and double-posting prevention (the same cost source
invoiced twice, an import invoice also entered through Purchases or
Expenses) are covered by the Stage 2–7 suites. Existing workflows are
covered by the Phase 2–4 suites, all rerun here.

### Blockers (not done, cannot be claimed)

1. **No signed-in browser walkthrough.**
   - There is no staging Supabase project and no Docker or local Supabase, and
     production must not be used. The new screens were therefore checked only
     through their server actions and RPCs in the test suites, and through
     unauthenticated route checks.
   - Forms, buttons and print layouts as a signed-in user have not been
     clicked through. This is a required runbook step on staging.
2. **Concurrency not exercised.**
   - Row locks (`for update` in a consistent order: company → product rows by
     id → document), advisory locks and idempotency claims are implemented and
     reviewed.
   - PGlite is single-connection, so two simultaneous postings were never run.
     Run a parallel posting test on staging.
3. **Live database** is at `0023` while `main` (deployed) already contains
   Stage 0–4 code (pushed earlier). See runbook §0.
4. **Credential rotation.** Production credentials (service-role key,
   database password, Owner initial password) were shared in a chat session
   during setup and must be rotated before release. Variable names are in the
   runbook; no values are recorded anywhere in the repository.

5. ~~Open stock-value defects D1 / D8~~: **fixed** by migration
   `0034_valuation_fixes.sql` (see "D1 and D8 fixes" below).

### D1 and D8 fixes (migration 0034, added after review)

- **D1:**
  - `void_inventory_opening` and `void_stock_adjustment` (increase) credit
    1150 with exactly the value the stock movements removed at the current
    average. The difference from the originally posted value goes to the
    `inventory.price_variance` mapping, as in `void_purchase` (0026).
  - A decrease void puts back exactly the value removed
    (`record_stock_movement_value`), not the line's unit cost (often 0).
  - Both voids also check that the void date's period is open, and lock
    products in id order.
- **D8:**
  - The database default time zone is Africa/Dar_es_Salaam (UTC+03:00, no
    daylight saving). `current_date`, column defaults and timestamp-to-date
    casts now follow the Tanzanian day.
  - App side: `todayISO`, `localDayStart` and `localDayEnd` in
    `src/lib/format.ts`. They are used for the "as of" inventory valuation
    cut-off, the shipment costing date range, the report period defaults and
    the default date on every form (29 files that used the UTC date).
- **Tests:**
  - `scripts/itest-valuation.ts` (18 checks): each void after the average
    moved keeps GL 1150 equal to the stock subledger, with variance and
    equity / gain amounts exact; the decrease void restores 400, not 0; the
    void journal is dated on the local day; a second void is refused; Cost
    Reconciliation `inventory_gl` is OK; the trial balance balances; the
    helpers are not app-callable; and the D8 time zone, date-cast and
    `current_date` checks pass.
  - The upgrade-path check now follows the runbook: dry run (nothing kept),
    migrate, `db:seed:upgrade` twice (names edited in Admin kept, new
    permissions granted), with all balances unchanged (25 checks).
- **Not rewritten:** drift already posted by old voids. The `inventory_gl`
  check shows any residual difference, which is corrected with a dated
  journal.

### Production database upgrade (22/10/2026, 08:44 UTC)

Applied to the live Supabase database at the user's request, following the
runbook:

1. `db:snapshot -- before`:
   - JSON export of 73 tables (558 rows), kept outside the repo in the
     operator's `~/letiq-backups`.
   - The live database was at `0023`, with no journals, stock or documents
     (master data only). Existing codes 1121/1122/1131/1132/1170/6300 had the
     expected types.
2. Dry run: all 11 pending migrations (0024–0034) applied in one transaction
   and were rolled back. OK.
3. `db:migrate`: 11 applied.
4. `db:seed:upgrade`: 27 new permissions, 76 new role grants, defaults
   ensured for 1 company.
5. Checks after the upgrade:
   - Trial balance, stock and 1150 unchanged (all still empty).
   - 11 new system accounts, 19 account mappings, 15 cost categories.
   - All 5 feature flags OFF.
   - All 13 Cost Reconciliation checks OK.
   - Private `documents` bucket present.
   - 0 security-definer functions callable by anon.
   - Database time zone `Africa/Dar_es_Salaam` (source: database) on new
     sessions.

Still open:
- The deployed app (`main`, Stage 0–4 code) must be replaced by this branch.
- Restart the project so pooled API connections pick up the time zone.
- Rotate the credentials.
- Do the signed-in walkthrough.

### Assumptions needing business review

1. Loss tolerances (rebagging and transfer) default to 0 %: every loss needs
   a decision until each product is configured.
2. Rebagging work in progress sits in 1150 (inventory), not a separate
   account, and is shown on Inventory Valuation.
3. Rebagging labour is capitalised by bag count by default (other charges by
   their documented basis). Size-specific packaging goes to its own output;
   common materials go by bag count.
4. Normal loss on a transfer is absorbed by the goods received; abnormal loss
   is written off (6300) or claimed (1145) at carrying value. Settling a claim
   for a different amount is a manual journal (no claim-settlement screen).
5. Storage and demurrage are expensed. Storage counts only in the commercial
   (pricing) overhead.
6. Late costs for units already sold go to cost of sales in the open period,
   not to the original period. Catch-ups are flagged.
7. Late-cost deltas posted before migration 0031 have no per-share evidence
   rows (`cost_delta_lines`). Reports show them as "no breakdown".
8. FX revaluation restates carrying amounts and is not auto-reversed.
9. The Owner can still edit master data through the Supabase Data API. A
   price changed that way bypasses `product_price_changes`, though it remains
   in the audit trigger log. The app's pricing screen always records history.
10. Driver licence numbers are visible only with `documents.view_licence`, and
    are never exported in CSV.

### Remaining open items carried from earlier stages

- Stage 1 D5, and caller-supplied
  idempotency keys outside transfers (2b).

### Production-readiness assessment

**Not ready for production** until blockers 1–4 are cleared:
- credentials rotated;
- staging project migrated, seeded and walked through signed in, with the
  scenario reproduced on screen;
- a parallel posting test run;
- the business assumptions above approved.

The database layer and posting logic are covered by passing automated tests,
and the deployment and recovery plan is documented.

---

## Stage 8 — Pricing and operational reports (implemented)

Migration `0032_pricing_reports.sql` (additive: one history table and
read-only reporting functions, plus one controlled price write) and new
screens. Every figure comes from posted documents and the cost versions of
Stages 4–7; amounts are TZS, dates DD/MM/YYYY.

### Pricing (Inventory → Pricing)

- **Accounting cost** = the branch's posted weighted-average cost per unit.
- **Commercial overhead** = an allocation of expensed charges flagged for the
  commercial view (storage etc.), per kg, following the goods from import
  receipts through rebagging and transfers (`commercial_overhead`). It is
  for pricing only: nothing is posted, and charges already in inventory cost
  are never added (only expensed charges qualify). The user can override it.
- **Pricing cost** = accounting cost + commercial overhead.
- Two separate modes (`src/lib/pricing/calc.ts`): **markup** — price before
  tax = pricing cost × (1 + markup); **gross margin** — price before tax =
  pricing cost / (1 − margin), margin validated to be below 100 %.
- VAT from the SKU's own tax code: exclusive codes add VAT on top; inclusive
  codes store the VAT-inclusive price. Both figures are shown.
- **Actual gross margin** uses the accounting cost; the **commercial
  contribution** (after overhead) is shown separately.
- A suggestion never replaces the approved price. Saving needs the Owner (the
  product master is Owner-only), a confirmation, and is recorded in
  `product_price_changes` (old / new price, costing basis, reason; insert-only)
  and the audit log. Inventory cost and posted documents do not change.

### Reports (Reports menu)

1. **Shipment Costing** — per shipment: purchase basis (incoterm, whether the
   price includes freight / insurance), goods estimated vs actual,
   capitalised acquisition costs estimated vs actual, expensed linked charges,
   unallocated charges, accrual variances (actual − accrued), costs awaiting
   invoice, received vs expected kg, cost per kg and per MT (estimated /
   actual) and commercial cost per kg; filter by period and costing state.
2. **Rebagging Costing** — per completed order: kg issued / packed / returned
   / normal and abnormal loss, materials consumed (incl. damaged), bulk /
   packaging / conversion value, cost per output SKU per bag and per kg
   (including later cost adjustments).
3. **Branch Landed Cost** — per branch and product: accounting average, per kg,
   per selected bag size (50 / 25 / 5 kg), last incoming transfer unit cost,
   commercial overhead per unit, pricing cost and the approved price; links to
   the pricing screen.
4. **In-transit dashboard** (Inventory → Stock Transfers / In Transit): now
   with an overdue flag (ETA passed, not received), agents, document counts,
   branch filter, pagination and a CSV export that never includes licence
   numbers, licence images or costs. Documents open only from the transfer
   page with the Stage 6 access checks.
5. **Transfer Costing** — per transfer line: source value, loading /
   transport / offloading / other capitalised charges (by value share),
   charges applied, value received, in transit, lost, incoming cost per unit
   and the destination's average after receipt.
6. **Profitability** — by item, pack size, branch, branch × item or
   **shipment (allocated)**. Revenue net of VAT, cost of sales at sale, returns,
   and **late cost adjustments in the period they were posted** (from the
   Stage 7 delta ledger). Shipment provenance uses `trace_receipt_units` /
   `shipment_sales_trace`: each sale is attributed to shipments by the same
   weighted-average replay as the costing engine (through rebagging and
   transfers); the report states that this is an **allocation of blended
   average cost, not exact lot profit**.
7. **Costing Exceptions** — unfinalised costs, unallocated charges,
   unresolved transfer losses (quarantine / short), missing documents (B/L,
   delivery notes, signed delivery note / proof of delivery), overdue arrivals
   (shipments and trips), accruals unmatched after 30 days, and stock / GL
   differences from the Stage 7 reconciliation.

All reports are company-scoped and limited to the user's branches (Owner:
all), paginated (50 rows), printable (browser print / save as PDF through
the existing Print button) and exportable to CSV with the existing tools —
no new dependencies.

### Acceptance (actual results)

`scripts/test-pricing.ts` (part of `npm test`): accounting 48,500 + commercial
1,500 = **pricing cost 50,000**; **20 % margin → 62,500** before VAT;
**20 % markup → 60,000**; accounting cost stays 48,500; at 62,500 the actual
gross margin on accounting cost is 14,000 (22.4 %) and the commercial
contribution 12,500 (20 %); margins of 100 % or more refused; VAT-exclusive
(62,500 + 18 % = 73,750, stored 62,500) and inclusive (stored 73,750) codes.

`scripts/itest-import8.ts`: storage 2M on 100,000 kg → 20/kg on the bulk;
bags after rebagging 30/kg (1,500 per 50 kg bag) and the same at Mwanza after
transfer; computing it posts nothing and the bag's accounting cost stays
45,000. The trace from the shipment receipt finds 20,000 kg sold as bulk,
70,000 kg held, 50 bags sold at HQ and 40 at Mwanza, 50 and 60 held;
provenance revenue / cost of sales reconcile to the sales. A late clearing
cost posted on 5 May appears in May's profitability (bulk 200k, HQ bags 25k,
Mwanza bags 20k), not April's. Price changes: Owner only, retry-safe,
recorded with basis, history immutable, no stock or journal change.

### Checks actually run (22/10/2026)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean |
| `npm run lint` | Same 20 pre-existing problems in other files; Stage 8 files lint clean |
| `npm run test:db` | All pass: … + 47 (Stage 7) + **17 (Stage 8)** + 22 upgrade-path |
| `npm test` | 7 + 25 + **13 pricing** checks pass |
| Breakage: trace ignores transfers | 2 checks failed; restored |
| Breakage: rebagged bags lose the bulk's overhead | 2 checks failed; restored |
| Breakage: price change without the Owner check | 2 checks failed; restored byte-for-byte, suite green |

### Limitations

- The screens and report layouts (responsiveness, filters, pagination,
  exports) were type-checked and linted but **not run in a browser**.
- PDF output for reports is the browser's print-to-PDF of the page.
- Commercial overhead follows goods through receipts, rebagging and
  transfers; overhead on goods bought through ordinary purchases is not
  allocated (purchase landed costs are capitalised, so they are already in
  accounting cost).
- Shipment provenance profitability is an allocation by the weighted-average
  replay and recomputes on each view (fine at current volumes; may need
  caching later).
- Transfer charge kinds are taken from the category (loading / transport);
  "offloading" is recognised from the charge description.
- Not applied to the live database; not pushed.

## Stage 7 — Late costs, corrections and accounting close (implemented)

Migration `0031_cost_adjustments.sql` (additive; original documents and
journals untouched) plus screens and reports. It completes the Stage 1
cost-delta algorithm (§7) across imports, purchases, rebagging and transfers.

### The algorithm (as built)

A TZS delta on a receipt (import receipt, purchase line, rebag output,
transfer receipt) is **replayed over the immutable stock movements** of its
weighted-average pool: each outflow takes `remaining × qty_out / balance
before` of the receipt's units (the quantity view of weighted-average
blending — never batch costing). Units that come back (sale void, sales
return, unused bulk returned, cancelled / voided rebagging) rejoin the pool.
The delta is split by those units with exact largest-remainder rounding:

| Where the units are now | Posting |
| --- | --- |
| held in the pool | stock value (Dr/Cr 1150); excess over a zero / emptied pool → 5100 |
| sold (per sale) | cost of sales 5100 |
| written off / abnormal loss | 6300 |
| returned to supplier | price variance 5300 |
| on a transfer trip | the trip's value pool in 1155 (in transit, quarantined, short), or on through the destination's pool once received; normal transit loss → destination stock; abnormal loss → 6300 |
| issued to rebagging | the order's held value (in production) or, once completed, its bags by kg (abnormal share → 6300) and on wherever the bags went |
| import line still in transit | 1157 |

Every part is written to **`cost_delta_lines`** (source document, target,
branch, product, reference — sale, movement, trip line, rebag order, shipment
line — units, amount). Together with `cost_allocation_runs / cost_allocations`
(how a source was split over lines) and **`cost_source_history`** (every
change of estimate / accrual / actual / status) this is the evidence behind
each balanced linked journal.

### What was added

- **Purchase landed costs**: cost sources owned by a posted stock purchase
  (freight, transport, handling, duty …; categories usable on imports or
  transfers). Estimate → explicit accrual (`accrue_purchase_cost`) → supplier
  invoice under Cost Invoices. Allocation by net kg, value, units or named
  lines; the delta follows the goods from the purchase receipt. A purchase
  with posted landed costs or price notes cannot be voided.
- **Supplier price notes** (`purchase_cost_adjustments`, TZS purchases):
  debit note (price higher) or credit note (price lower) per purchase line.
  The supplier balance changes exactly once; a credit beyond the open balance
  (invoice already paid) becomes a **supplier credit** (1170). Foreign
  purchases keep using supplier credits / returns.
- **Cost-invoice credit notes beyond the open balance** now become supplier
  credits instead of being refused; credits can never exceed the credited
  invoice.
- **Supplier refunds** (`refund_supplier_credit`): cash / bank in, 1170 out;
  partial refunds; Purchases → Supplier Credits.
- **Reversal of a posted cost invoice** (`void_cost_invoice`,
  `cost_invoices.void`, reason): only while unpaid and without credit notes.
  Reverses the payable and VAT today, re-instates the accrual it replaced,
  takes out only the difference it had made (through the same propagation),
  frees the supplier invoice number. The invoice and its journal stay.
- **Returns after an adjustment**: posting a sales return (or voiding a sale)
  brings the late cost recorded on that sale for those units back to stock
  (Dr 1150 / Cr 5100, ratio = units returned / units sold). Voiding a return
  takes the units out at the current average (which carries their late cost)
  and now aligns the GL with that value (fixes Stage 1 D1 on this path).
- **Closed periods**: deltas post on their own document date, which must be
  in an open period — nothing is backdated or reopened. Shares that reach
  sales of closed periods are **catch-ups** in the open period, shown with the
  original document and date in **Reports → Late Cost Adjustments**.
- **Reports → Cost Reconciliation** (`cost_reconciliation_checks`): stock
  quantity = movements; stock value = last movement; transfers conserve
  quantity; rebagging conserves kg; every allocation equals its source; every
  journal balances; 1150 = stock subledger + rebagging WIP + pre-upgrade
  transit; 1155 = value on open trips (listed); 1157 = import lines in
  transit; GR/IR 2130 = open items per shipment (listed); 2140 = accrued
  charges awaiting invoice (listed); 2110 = supplier ledger; 1170 = open
  supplier credits. The payables ageing now includes service-invoice payables
  and supplier price notes.
- **Cost Invoices** can be posted against transfer charges and purchase landed
  costs (the transfer link was missing from the Stage 6 form) and reversed
  from the list.

### Acceptance (actual results, `scripts/itest-import7.ts`)

- 1,000 equal bags (40,000 each), 400 sold, 600 held: a further eligible
  TZS 1,000,000 → **600,000 inventory + 400,000 cost of sales** (accrual
  journal 1150 600,000 / 5100 400,000 / 2140 1,000,000); the evidence shows
  600 units held and 400 units on the sale. The **matching invoice** posts
  only Dr 2140 / Cr 2110 — zero extra inventory cost.
- Destination and in-transit shares: 1,000 bags, 400 sold, 300 transferred
  (200 received): a late 1,000,000 → HQ held 300k, sold 400k, Mwanza 200k,
  in transit 100k (1155), which arrives with the last 100 bags.
- Negative correction (credit note 200k) splits the same way; credits cannot
  exceed the invoice; a supplier price credit of 100k after HQ sold out goes
  to cost of sales for HQ's share and −30k at Mwanza, payable −100k.
- Blended receipts: two receipts at 1,000 and 2,000, half sold → the first
  receipt's 10,000 splits 5,000 sold / 5,000 held; a later credit splits the
  same way.
- Returns after adjustment: returning 100 of the 400 bags brings their
  100,000 back; a further 700,000 then splits 490k held / 210k sold; voiding
  the return takes them out at average and aligns the GL (170k).
- Rebagging → transfer → sales: a late 1M on bulk ends as bulk 500k, HQ bags
  200k, Mwanza bags 50k, cost of sales 250k.
- Cost-invoice reversal: 12,000 vs 10,000 accrual (+2,000) reversed (accrual
  back, −2,000), corrected invoice with the same number posts +1,000; retry
  posts once; storekeepers refused; invoices with credit notes refused.
- Vendor refund: credit note on a paid purchase → supplier credit 5,000;
  refund 3,000 in cash (retry once), 2,000 left; over-refund refused.
- Closed January: a cost dated in January is refused; dated in March it
  posts, and the January sale's share is reported as a catch-up with the
  sale's number; nothing is posted into January.
- All 13 reconciliation checks pass on the fixture.

### Checks actually run (22/10/2026)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean |
| `npm run lint` | Same 20 problems in files not touched by Stage 7; Stage 7 files clean |
| `npm run test:db` | All pass: 19 + 26 + 11 + 51 + 114 + 79 + 58 + 50 + 59 + **47 (Stage 7)** + 22 upgrade-path |
| `npm test` | 25 attachment policy checks pass |
| Breakage: no late cost restored on returns | 3 checks failed; restored |
| Breakage: replay ignores units given back by returns | 2 checks failed (466,666.67 instead of 490,000); restored |
| Breakage: delta ledger disabled | 6 checks failed (evidence, returns, catch-up report); restored byte-for-byte, suite green |

### Decisions and assumptions

- Weighted average is kept everywhere: a late cost follows the receipt's
  units through the pool by the proportional replay, not by batch identity.
- Late costs reaching emptied pools go to cost of sales; voided-trip shares
  go back to the source pool.
- The accrual account 2140 is shared by import, rebagging, transfer and
  purchase charges; reconciliation lists every open accrual.
- Sale voids and returns restore late cost in proportion to units; damaged
  returns (not restocked) leave it in cost of sales.

### Limitations

- Concurrency: posting functions lock the stock rows they touch in a fixed
  order and use idempotency keys, but the test database has one connection,
  so truly simultaneous sessions were **not** tested — only retries and
  repeated calls.
- Screens not run in a browser (production is the only configured database).
- Supplier price notes are TZS only; foreign purchases use credits / returns.
- A cost invoice with payments or credit notes cannot be reversed; use a
  credit note.
- Reconciliation checks are current-position; historical (as-of) versions
  of the new checks are not built.
- Pre-0031 deltas (Stages 4–6) have no `cost_delta_lines` evidence; only
  deltas posted from now on are itemised.
- Not applied to the live database; not pushed.

## Stage 6 — Transfer costs and complete dispatch file (implemented)

Migration `0030_transfer_logistics.sql` (additive: new tables / columns,
wider checks, replaced functions; no data re-posted) plus the reworked
Inventory → Stock Transfers / In Transit screens. It builds on the existing
stock transfer: one shared transfer, seen by the sending and the receiving
branch.

### Behaviour

- **Accounting (fixes Stage 1 D2 for every transfer dispatched from now on).**
  Dispatch: Dr 1155 stock in transit / Cr 1150 at the source weighted average.
  Receipt: Dr 1150 / Cr 1155 for the accepted quantity at its trip's value,
  including charges applied so far; the destination average updates through
  the normal weighted-average receipt. No revenue or margin is posted.
  Transfers already in transit before 0030 keep the original behaviour
  (`posts_in_transit = false`, value stays in 1150) and are still receivable.
- **Trips.** A transfer can travel on several trips
  (`stock_transfer_dispatches`). Each trip has its own driver (name, phone,
  licence number), truck and trailer, transporter and contact, dispatch date,
  expected and actual arrival, cargo lines (quantity, net kg, value) and
  receipts. Each trip keeps its own value pool, so it can be reversed exactly.
  Dispatched quantities are locked; over-dispatch beyond the request is
  refused. Several agents (name, company, phone, role) per transfer.
- **Receipts** (`receive_transfer_trip`, receiving branch only) split arrived
  cargo into **accepted** (into stock), **quarantined / damaged** and
  **short**. Quarantined and short cargo stay in 1155, not saleable, until an
  approver (`inventory.transfer_resolve`) resolves them:
  release / found (into stock), **normal loss** (only within the product's
  transfer loss tolerance %; absorbed into destination stock), **write-off**
  (6300) or **claim** (1145). Abnormal shortages are never spread over
  accepted goods. Partial receipts per trip; a repeated request returns the
  first receipt.
- **Charges** (loading, transport, offloading, other) are cost sources on the
  transfer or on one trip. Estimates post nothing; accruals are explicit
  (`accrue_transfer_cost`, `inventory.transfer_cost`); supplier invoices —
  including the receiver's offloading invoice — post through Cost Invoices.
  The actual replaces the accrual and only the difference moves cost; a charge
  takes one actual invoice. Allocation by **net kg** by default (not equally
  per bag across mixed sizes), or by value, units, or directly to lines. A
  charge follows the cargo: in transit → 1155; accepted → the destination
  stock and wherever it went since; normal loss → destination stock; written
  off / claimed → 6300. Cost status (estimated / provisional / finalized /
  adjusted) is independent of the logistics status.
- **Corrections.** A trip with nothing received and no charge applied can be
  voided (`transactions.void`): its exact value returns to the source. Driver
  / vehicle changes after dispatch keep the previous details and the reason
  (`stock_transfer_dispatch_changes`). Received cargo is corrected through
  resolutions or a return transfer.
- **Delivery notes.** `issue_delivery_note` stores a snapshot per trip in
  `document_versions` (with a SHA-256): a new version only when the content
  changed; old versions stay. The PDF (company identity, references,
  sender / receiver, dates, items, quantities, units, net kg, driver, vehicle,
  agents, signature spaces) is rendered from the snapshot by a built-in PDF
  writer (`src/lib/pdf/simple-pdf.ts`; no new dependency) at
  `/api/transfers/delivery-notes/<version>`. It shows no costs and no licence
  number; issuing or downloading posts nothing.
- **Documents.** Trips own attachments: driver licence, cargo papers / B/L,
  loading photos, weighbridge tickets, transport invoice, signed delivery
  note, offloading photos, other — in the Stage 2 private bucket with
  versions. Licence images need the new `documents.view_licence`; transport
  invoices need `documents.view_financial`. Links are short-lived and re-checked
  on every request.
- **Visibility.** Row-level security now limits transfers and everything
  under them to users of the sending or receiving branch (Owner: all); the
  server actions and database functions check the acting branch too (fixes
  Stage 1 D3). Licence numbers are not readable by app users directly (column
  grants); screens show them only with `documents.view_licence`. Costs show
  only with `inventory.view_cost`.
- **In transit view.** List of open transfers for both branches with trips,
  driver / vehicle contacts, departure / ETA, dispatched / received /
  outstanding, held (quarantined / short) quantities, discrepancy status and
  latest update; detail with cargo per trip, receipts and resolutions,
  timeline (dispatch, charges, receipts, delivery notes, manual updates),
  agents, charges (finance only) and documents. Positions are as recorded by
  the branches — there is no live GPS tracking.
- **Retry safety (Stage 1 D4 for transfers).** Stable keys for dispatch, trip
  dispatch, receipts (per form), resolutions, voids and accruals.
- **Reports.** Inventory valuation reconciles 1150 with branch stock plus
  rebagging work in progress and pre-upgrade transfers in transit; the period
  checks add "stock in transit vs 1155".

### Acceptance (actual results, `scripts/itest-import6.ts`)

- 1,000 bags at TZS 46,500 dispatched (Dr 1155 / Cr 1150 46.5M); loading
  200,000 (trip, accrued) + transport 1,500,000 (accrued) + offloading
  300,000 (receiver's supplier invoice) → **receipt value TZS 48,500,000,
  48,500 per bag**; with 500 bags worth 25,000,000 already at Mwanza the new
  average is **73,500,000 / 1,500 = TZS 49,000**. A later transport invoice of
  1.6M moves only +100k into the bags held.
- Two trips with their own drivers; partial receipt 180 accepted / 10
  quarantined / 10 short at exactly 20,000 each (shortage not spread);
  release 6, write-off 4, normal loss 4 (2% tolerance enforced), claim 6;
  every bag reconciles (300 = 286 accepted + 14 lost); 6300, 1145 and stock
  values as expected; duplicate receipt requests post once.
- Void of an unreceived trip returns the exact value; a received trip cannot
  be voided; driver change keeps old values and reason.
- Delivery note: v1 reused while unchanged, v2 after a change; no licence or
  costs in the content; the PDF is valid, deterministic and contains the
  reference, quantities and signature spaces; issuing posts nothing; an
  unrelated branch cannot issue it.
- Attachments: sender loading photos, receiver signed delivery note,
  versioning; storekeepers refused for licence images and transport
  invoices; unrelated branch denied.
- RLS: sender and receiver see the same transfer, trips, cargo, timeline,
  agents and receipts; an unrelated-branch user sees none; licence column not
  readable; cross-company transfer rejected.
- Reconciliation: journals balance; 1150 = stock subledger; 1155 = value on
  trips in transit; 2140 = accrued charges; line totals = their trips.

### Checks actually run (22/10/2026)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean |
| `npm run lint` | Same 20 problems (11 errors, 9 warnings) in files not touched by Stage 6; Stage 6 files lint clean |
| `npm run test:db` | All pass: 19 + 26 + 11 + 51 + 114 + 79 + 58 + 50 + **59 (Stage 6)** + **22 upgrade-path** (2 new: a pre-0030 transfer keeps the old engine and is still receivable without journals) |
| `npm test` | 25 attachment policy checks pass |
| Breakage: charges not added to cargo in transit | 6 checks failed (incl. both acceptance values); restored |
| Breakage: normal-loss tolerance not checked | Tolerance check failed; restored |
| Breakage: transfer RLS back to company-wide | Unrelated-branch check failed; restored byte-for-byte, suite green |

### Decisions and assumptions

- Pre-0030 transfers in transit are not reclassified to 1155 (no migration
  journals); they finish on the original engine and are shown separately in
  the valuation reconciliation.
- Each trip line keeps its own value pool; charges on the whole transfer are
  spread over the trips dispatched so far (later trips take only their own
  trip charges).
- A charge needs at least one dispatched trip before it can be accrued or
  invoiced.
- Claims are booked at carrying value to 1145; any settlement difference is a
  later finance entry. Late costs on claimed / written-off units go to 6300.
- New permissions: `inventory.transfer_cost` (Director, Accountant),
  `documents.view_licence` (Director; Owner has all). The menu item needs
  `inventory.transfer_view`.

### Limitations

- Screens type-check and lint clean but have **not** been run in a browser
  (production is the only configured database).
- Concurrency tested as repeated / retried calls only (single-connection
  test database).
- The delivery note uses standard PDF fonts (Latin characters) and no logo
  image.
- Historical (past-date) inventory valuation cannot separate rebagging work
  in progress or legacy transit; the reconciliation adjustment applies to the
  current position.
- A trip that received a charge cannot be voided; credit the charge first.
- Not applied to the live database; not pushed.

## Stage 5 — Bulk-to-bag rebagging (implemented)

Migration `0029_rebagging.sql` (additive: new columns, wider status and
movement-type checks, new functions; `_propagate_from_movement` and
`post_cost_invoice` replaced with the import behaviour unchanged) plus
Inventory → Rebagging screens, behind the `rebagging` feature flag and the
`rebagging.*` permissions (new: `rebagging.approve`, given to Director; Owner
has everything).

### Behaviour

- **Products.** Bulk products (kg) and packaged SKUs keep separate stock
  balances; a packaged SKU names its bulk product and its net kg per bag
  (50 / 25 / 5 or any positive weight; no size is hard-coded). Packaging
  materials are ordinary stocked products (`packaging_material`). Bulk
  products carry a **rebagging loss tolerance %** (Admin → Products, default
  0). Other products and units are untouched.
- **Order.** Branch, location/bay, operator, date, bulk product, optional
  import shipment, bulk batches (lots) with kg, packaged outputs (SKU and
  whole good bags; net kg = bags × pack kg), unused bulk returned, normal and
  abnormal loss kg, packaging materials actually used (per output or common;
  used, damaged, quantity per bag), conversion charges (labour / contractor,
  with allocation basis), attachments.
- **States.** `draft → issued → completed → voided`, and `draft / issued →
  cancelled`. Status changes only through the posting functions (trigger).
  - **Issue** (`issue_rebag_order`): bulk kg leave bulk stock at the weighted
    average; the value is held on the order (work in progress, still inside
    1150 — no clearing account). Batch balances are reduced and must cover the
    kg; batches must come from the order's shipment when one is set (or set
    it). The bulk issue, branch, product and shipment are frozen from here.
  - **Complete** (`complete_rebag_order`) from draft issues and completes in
    one transaction; from issued it uses the issued kg and value — the issue
    is never consumed twice.
  - **Cancel** (`cancel_rebag_order`): a draft closes with no postings; an
    issued order returns all bulk at its issue value and restores the batches.
  - **Void** (`void_rebag_order`, `rebagging.void`, reason): only while none
    of its bags have been sold, transferred or adjusted without reversal
    (`rebag_order_dependents` lists them), no charge has its supplier invoice
    and no later cost has reached the bags. It returns bulk and packaging at
    their recorded values, removes the bags at their value, and mirrors the
    completion journal.
- **Kg conservation** (enforced): issued kg = good packaged net kg + bulk
  returned + normal loss + abnormal loss, exactly (4 dp). Empty packaging
  weight is never product kg.
- **Loss.** Normal loss may not exceed issued kg × tolerance %; the rest must
  be recorded as abnormal (the error says how much), so tolerance never makes
  all loss capitalisable. Abnormal loss needs `rebagging.approve` and is
  expensed to 6300 at the issue cost; normal loss stays in the bags.
- **Packaging.** Each material line is consumed from stock at weighted
  average (insufficient stock rejects the whole completion). Bag-specific
  materials go only to their own size; common materials (thread, labels) by
  bag count. With "per bag" set, used − damaged must equal good bags ×
  quantity per bag, so shortages, unused and damaged bags reconcile; damaged
  bags are part of that size's packaging cost.
- **Conversion charges** are rebagging cost sources. Completion accrues each
  (Cr 2140): capitalised ones are allocated to the outputs by their basis
  (labour default: **bags**, or kg / bulk value / direct), expensed ones go to
  their expense account. The contractor's invoice is posted under
  Importation → Cost Invoices against the charge: it replaces the accrual and
  only the difference changes cost; a charge takes one actual invoice, and a
  capitalised line without its charge is refused, so labour is never expensed
  twice.
- **Value.** Bulk to outputs = issued value − returned share − abnormal share,
  split by output net kg; plus packaging; plus capitalised conversion. Each
  output enters packaged stock through the weighted-average receipt and gets a
  lot traced to the bulk batches (`stock_lot_flows`). One journal: Dr 1150
  packaged output; Cr 1150 bulk consumed and packaging; Dr 6300 abnormal loss;
  Cr 2140 accrued charges (Dr expense for expensed ones). No income, no
  clearing balance; an internal check stops completion if output value ≠
  inputs.
- **Late costs through conversion.** The Stage 4 replay now follows bulk into
  rebagging: units issued to a completed order go to its bags by kg (abnormal
  share to 6300) and on to wherever the bags went; units on an issued order
  raise its held value; returned / cancelled / voided units rejoin the bulk
  pool. Packaging materials are followed the same way. Conversion-charge
  differences go to the bags by the charge's basis.
- **Several runs per shipment**: each order links its shipment (from the
  batches); the shipment page lists its rebagging runs.
- **Locking / retries:** every order locks its stock rows in (branch,
  product) order before posting; stable keys per action
  (`issue_rebag_order:<id>` etc.) make retries replay the first result.

### Screens

Inventory → Rebagging: list (in production, bulk in production, drafts), new
order, edit / record results (draft and issued), detail (kg balance, value
build-up per size and per bag, batches, packaging, charges, blocking
documents, attachments) with Issue, Complete, Cancel, Void and Delete draft.
Cost Invoices can now link rebagging charges. The shipment page shows its
rebagging runs. Admin → Products has the loss tolerance.

### Acceptance (actual results, `scripts/itest-import5.ts`)

- **A:** 100,000 kg → 1,000 × 50 kg, 1,600 × 25 kg, 2,000 × 5 kg, no loss:
  three SKUs with 1,000 / 1,600 / 2,000 bags (4,600 bags, 100,000 kg), bulk
  fully consumed, 900/kg in every size (45,000 / 22,500 / 4,500 per bag),
  completion journal entirely within 1150.
- **B:** 1,000 × 50 kg from bulk at 900/kg, bags at 1,000 and labour 500/bag:
  **TZS 46,500 per bag**; journal Dr 1150 46.5M / Cr 1150 46M / Cr 2140 0.5M.
  The contractor invoice of 520k replaces the accrual and moves the bags to
  46,520.
- Issue then complete with 200 kg returned and 50 kg loss at 0.2% tolerance:
  all-normal rejected ("record 30 kg as abnormal"); storekeeper cannot approve
  abnormal loss; packaging that does not reconcile is rejected; a packaging
  stock shortage rejects the completion with nothing posted; the completed
  order expenses 30k abnormal loss, returns 200 kg at 10.2M, and the output
  value equals bulk + packaging exactly, with different packaging cost per kg
  per size.
- Two runs from one shipment batch; batch balance 2,000 kg left; output lots
  trace to the batch; over-issuing the batch rejected; a late 1M clearing cost
  splits 0.2M to bulk held and 0.8M into the 160 bags.
- Draft and issued cancellation; void refused while bags are sold (document
  listed), allowed after the sale is reversed; storekeeper cannot void.
- Retries of issue and completion post once; second issue / completion
  rejected; direct status changes rejected; app users cannot call the
  functions.
- Reconciliations: every journal balances; 1150 = stock subledger + work in
  progress; 2140 = charges accrued not invoiced; kg conserved on every order.

### Checks actually run (22/10/2026)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean |
| `npm run lint` | Same 20 problems (11 errors, 9 warnings) in files not touched by Stage 5; Stage 5 files lint clean |
| `npm run test:db` | All suites pass: 19 + 26 + 11 + 51 + **114 (Stage 2, one check updated)** + 79 + 58 + **50 (Stage 5)** + 20 upgrade-path |
| `npm test` | 25 attachment policy checks pass |
| Breakage: abnormal loss not expensed | 2 checks failed (6300 journal, output = inputs); restored |
| Breakage: rebag outflow sent to cost of sales | Late-cost-through-conversion check failed (0.8M went to 5100); restored |
| Breakage: batch balance not checked | Over-issue check failed; restored byte-for-byte, suite green |

The Stage 2 check "packaging input must target an output" was replaced by
"bulk input cannot target an output": Stage 5 deliberately allows common
packaging materials.

### Decisions and assumptions

- Work in progress stays in 1150 (value held on the order) rather than a WIP
  account; the reconciliation includes it.
- Labour and contractor charges are capitalised by bag count by default
  (piece-rate handling); the basis can be changed per charge. Own-staff wages
  already expensed elsewhere are not reclassified here.
- Damaged packaging is a normal cost of the size it was used for.
- Default loss tolerance is 0% until set per bulk product (Stage 1 suggested
  0.2%; to be confirmed).
- Rebagging accruals use the shared 2140 accrued-costs account.

### Limitations

- Screens type-check and lint clean but have **not** been run in a browser
  (the only configured Supabase project is production; no local Supabase).
- Concurrency was tested only as sequential retries and repeated calls (the
  PGlite harness has one connection); real parallel sessions rely on the row
  locks and keys.
- Void is refused once a later cost adjustment has reached the bags or a
  charge has its invoice; such orders are corrected with a new order.
- Draft line edits replace the lines in several statements (not one
  transaction); a failure can leave a draft partly edited, never a posting.
- Cost invoices for rebagging charges need the Importation screens (the
  `imports` flag) to be reachable in the menu.
- Not applied to the live database; not pushed.

## Stage 4 — Import shipments and landed cost (implemented)

Migrations `0027_import_shipments.sql` and `0028_import_corrections.sql`
(additive; existing stock, journals and balances untouched) plus the Importation screens, all behind the `imports`
feature flag and the `imports.*` / `cost_invoices.*` permissions.

### Behaviour

- **Shipment** records supplier, reference, origin country/port, discharge
  port, vessel, containers, bill of lading, delivery terms + named place,
  whether the price already includes freight / insurance, ETA / shipped /
  arrival dates, destination warehouse, currency and planning rate, and the
  ownership event (`bill_of_lading`, `arrival` or `receipt`). Lines carry
  product, batch reference, ordered and shipped kg (bulk: quantity = net kg;
  packaged bags are rejected — bags come from rebagging).
- **Quantities kept apart per line:** ordered, shipped, invoiced, received,
  shortfall (normal / write-off / claim) and in transit
  (`_line_transit_kg`). Only receipts create stock, and only bulk stock.
- **Ownership** (`recognise_import_ownership`): Dr 1157 goods in transit /
  Cr 2130 GR/IR at the goods value (invoice value where invoiced, accrual
  rate otherwise). When the ownership event is `receipt`, it happens inside
  the first receipt.
- **Goods invoice** (`post_import_goods_invoice`, via an `invoice_only`
  purchase so it shares the supplier-invoice registry and foreign payables
  from Stage 3): clears 2130 and creates the supplier balance. If ownership
  is already recorded, only the difference from the provisional value moves
  cost (to stock held / cost of sales / in transit pro rata). The ordinary
  purchase void and purchase returns stay blocked for these invoices.
- **Correcting a goods invoice** (`void_import_goods_invoice`, 0028,
  permission `imports.void`, reason required): allowed while the supplier
  balance is untouched (no payments, credits or revaluations). It reverses
  AP, input VAT and GR/IR, cancels the payable, gives back the invoiced
  quantity on the shipment line, and, once ownership is recorded, returns the
  line to its provisional value (accrual rate; the voided invoice's rate if
  none was recorded). Only that difference moves cost, through the same
  propagation. The posted invoice and its journals are kept; the corrected
  invoice is then posted normally.
- **Cost lines** (`cost_sources`): category, description, supplier,
  allocation basis / targets, estimate. Estimates never post. `accrue_import_cost`
  is an explicit action (Dr 1157 or the expense account / Cr 2140).
  Freight or insurance categories are rejected when the shipment price
  already includes them (no CIF double count).
- **Cost invoices** (`post_cost_invoice`, TZS only): each capitalised line
  must link one open cost line; the accrual is reversed and only the
  difference from it changes cost. Expense-category lines may be unlinked.
  Credit notes adjust an invoiced cost and cannot exceed it or the open
  balance of the credited invoice. Recoverable VAT goes to input VAT, never
  stock; non-recoverable tax is capitalised with the line.
- **Storage** and other expense categories post to their expense account
  (e.g. 6150) and appear in the shipment's commercial cost only.
- **Receipts** (`post_import_receipt`): net kg, weighbridge ref, batch,
  location, "last receipt" flag. Each receipt takes its kg share of the
  in-transit value; the last receipt of a line takes the exact remainder.
  A shortfall on the last receipt needs `imports.approve` and a resolution
  (normal loss absorbed into the received kg, write-off to expense, claim to
  receivable). A lot is created per receipt line.
- **Late costs** after receipt are replayed over the immutable stock
  movements from that receipt, pro rata to what happened to the goods: still
  held → stock value; sold → cost of sales; written off → loss; in a branch
  transfer → in-transit unit cost or the destination branch (recursive).
  Units of a sale that is later voided or returned rejoin the stock pool
  (0028), so a later cost follows them back into stock.
- **Landed-cost sheet** (`landed_cost_sheet`): estimated vs actual per cost,
  stock cost per kg and commercial cost per kg. **Finalisation**
  (`import_finalization_checks` / `finalize_import_shipment`) requires all
  lines closed, goods fully invoiced, no estimate-only or accrued-not-invoiced
  costs, and 1157 / 2130 / 2140 cleared for the shipment.
- **Retry safety:** stable idempotency keys per posting and
  `client_request_id` on receipts and cost invoices; a repeated request
  returns the first result.

### Screens

Importation menu: Shipments (KPIs: open, in transit, costs awaiting
invoice, unallocated costs), New Shipment, shipment detail (quantities,
landed-cost sheet, costs with accrue / void, goods invoices, receipts,
traceability, finalisation checks, attachments), Goods Invoice, Receive
Goods, Cost Invoices list and New Cost Invoice. Goods invoices on the
shipment page have a Void action (reason required).

### Acceptance (actual results, `scripts/itest-import4.ts`)

- 100 MT at TZS 80,000,000 + TZS 10,000,000 capitalised cost → 100,000 kg at
  **900.00/kg**.
- Storage TZS 2,000,000 → expensed, stock value unchanged; commercial cost
  **920/kg**.
- Partial receipts (60,000 kg, then the final 40,000 kg taking the exact
  remainder) reconcile to the shipment total of TZS 90,000,000.
- Freight cost line on a CIF shipment is rejected.
- Repeating a receipt request creates no second stock movement or journal.
- Late clearing cost of 4.0M after the first receipt and a sale splits
  exactly: 2.0M stock held, 0.4M cost of sales, 1.6M still in transit.
- Receipt-time ownership with a 10 kg write-off: Dr 1150 990k, Dr 6300 10k,
  1157 / 2130 net to zero.
- Foreign-currency shipment with a transfer: all stock ends at 1,060/kg.
- Voiding the USD invoice (posted at 2,650) puts the goods back to the 2,600
  accrual: -1M split across HQ (-0.6M) and Mwanza (-0.4M), payable cancelled,
  GR/IR reopened at 52M. Retry posts nothing more; the replacement invoice
  restores 53M and clears GR/IR.
- Late cost of 100k after sales of 400 kg (later voided), 100 kg and 200 kg
  from a 1,000 kg receipt: 70k to stock held (700 kg), 30k to cost of sales.
- Reconciliations 1150 = stock subledger, and 1157 / 2130 / 2140 per shipment.

### Checks actually run (21/10/2026, re-run 22/10/2026 after 0028)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean |
| `npm run lint` | 20 problems (11 errors, 9 warnings), all in files not touched by Stage 4 — same count as the tree without Stage 4 changes. Stage 4 files lint clean. |
| `npm run test:db` | All suites pass: 19 + 26 + 11 + 51 + 114 + 79 + **58 (Stage 4)** + 20 upgrade-path checks |
| `npm test` | 25 attachment policy checks pass |
| Deliberate breakage: late-cost propagation stopped adjusting held stock | Stage 4 suite failed 5 checks (900/kg remainder, storage, FX transfer cost, 1,060/kg, 1150 reconciliation); migration restored byte-for-byte and suite green again |
| Deliberate breakage (0028): returned units not given back to the pool | Sale-void check failed (64,814.81 held instead of 70,000); restored |
| Deliberate breakage (0028): sale voids ignored (pre-0028 behaviour) | Sale-void check failed (38,888.89 held instead of 70,000); restored |

### Decisions and assumptions

- Goods are costed at the goods-invoice rate; the ownership-date amount is
  provisional and trued up by the invoice (Stage 1 Decision 2 alternative —
  a deliberate deviation from strict IAS 21 spot-at-recognition).
- In-transit unit cost on transfers is stored to 4 decimals; rounding
  differences are absorbed by the final receipt / remainder rules.
- Normal loss is absorbed into the received kg; write-off and claim are
  valued at the in-transit unit cost.

### Limitations

- A paid, credited or revalued goods invoice cannot be voided until those
  are reversed; there is no partial credit note for goods (void and re-post).
- The sales-return path of the return-aware replay shares the sale-void code
  but has no test of its own (a sales return needs a full posted sale in the
  fixture); the sale-void path is tested.
- Screens type-check and lint clean but have **not** been walked through in
  a browser: the only configured Supabase project is production and there is
  no local Supabase (no Docker), so a walkthrough would write live data; no real concurrent-request test was run (concurrency safety rests
  on row locks and idempotency keys tested sequentially).
- Not applied to the live database. The code was pushed to GitHub on
  21/10/2026 at the user's request; migrations 0024–0028 must be applied to
  the live database before that code runs there (see Stage 0 instructions).
- Stage 2b defects (D1 for openings / adjustments, D2–D5) remain open.

## Stage 3 — Foreign purchases with TZS books (implemented)

Migration `supabase/migrations/0026_foreign_purchases.sql`. Extends the
existing purchases, supplier payables, supplier payments, supplier credits,
purchase returns and supplier statements — no separate foreign ledger. All
foreign-currency entry points require the `fx_settlement` feature flag (off by
default) and permissions; TZS purchasing keeps its behaviour.

### Behaviour

**Purchase invoice.** Defaults to TZS (rate fixed at 1). With `fx_settlement`
on and `fx.enter_rate` permission, a purchase can be in a configured currency:
line prices, discounts, tax and totals are entered in that currency; the
purchase stores `currency_code`, `exchange_rate` (TZS per 1 unit, > 0, ≤ 6
decimals), `rate_source` (`manual` = authorised manual rate, or
`rate_table` = must equal the Admin → Exchange Rates entry on/before the
date), `rate_reference`, and per line `fc_*` amounts. On posting each line's
TZS net and tax = round(foreign × rate, 2); the posted TZS figures, rate and
currency are **immutable** (trigger). Foreign purchases cannot carry instant
payments — they are settled through Supplier Payments. Draft TZS figures are
previews; posting recomputes them.

**Supplier balance.** A foreign invoice's `supplier_payables` row keeps
`fc_outstanding` (original currency) and `outstanding` (TZS carrying amount).
Every change is an immutable `supplier_payable_events` row (invoice,
settlement, return, credit application, revaluation and their voids), so
balances as of any date and statements are rebuilt from the log; a test
checks the log reproduces every balance. `recalc_purchase` no longer
recomputes foreign balances from TZS totals (it mirrors the event-maintained
payable).

**Settlement.** A supplier payment has a currency. Funding is always existing
TZS bank / cash / mobile-money accounts (actual TZS paid). For a foreign
payment each allocation records the foreign amount settled; on posting the
actual TZS paid is shared across the allocations (and any advance) in
proportion to the foreign amounts (exact-sum allocation), the payable's TZS
carrying share for that foreign amount is released (the whole remainder when
fully settled), and paid share − carrying released is realised FX:
Dr 2110 released, Dr 6400 loss / Cr 4400 gain, Cr bank. Bank charges are a
separate field posted Dr 6200 / Cr the chosen account — never mixed into FX.
TZS payments can settle only TZS invoices and foreign payments only invoices in
their own currency (both enforced in the database).

**Advances.** An unallocated part of a payment is a supplier advance: a
non-monetary prepayment carried at the TZS actually paid (Dr 1175), never
revalued. Advances are applied **when posting the invoice**: the prepaid
foreign share of the goods is costed at the advance's historical TZS (the
difference to the invoice rate adjusts the goods' cost, spread by value), the
payable is created only for the unpaid part, and no FX gain/loss arises
(transaction-date treatment). Applying an advance to an already-posted
invoice is not offered (it would manufacture an FX result); void and re-post
the invoice instead. Voiding the purchase restores the advance; a payment
whose advance has been applied cannot be voided.

**Revaluation.** Accounting → FX Revaluation (`fx.revalue`). At a period-end
date the user enters an authorised closing rate for every currency with open
balances (manual with reference, or the rate table). Each open foreign
payable and supplier credit is restated to round(foreign × closing rate, 2);
the difference is posted Dr 6410 / Cr 2110 (liability up) or Dr 2110 / Cr
4410, and for credits Dr 1170 / Cr 4410 or Dr 6410 / Cr 1170, in one
balanced journal linked to the revaluation document (`FXR…`). The carrying
amount itself is updated — there is no automatic reversal — so a later
settlement measures realised FX from the revalued amount and unrealised +
realised = total TZS paid − original carrying (no double counting; tested).
Rules: one posted revaluation per date; all open currencies must be rated;
no foreign transactions may be dated after the revaluation date (revalue in
date order); later settlements / returns / credit applications cannot be
dated before the last revaluation of that balance; a revaluation can be
voided only while nothing later used the revalued amounts.

**Returns and credits.** Policy for foreign purchases, consistent with the
original purchase and the existing stock-return logic: goods, VAT and price
variance are valued at the **original invoice rate** (the purchase's TZS line
amounts, pro rata; the last unit takes the exact remainder); stock leaves at
current average with any difference to 5300 as today. *Reduce payable*
releases the payable's carrying share for the foreign amount returned; any
difference from the original-rate value is the reversal of previously booked
unrealised FX (4410 / 6410) — never inventory cost. *Supplier credit*
creates a foreign credit (Dr 1170) carried at the original-rate TZS; credits
are revalued like payables. Cash refunds on foreign returns are not offered
(use a credit). **Applying a credit** to an open invoice of the same supplier
and currency (purchase page) releases the credit's carrying share and the
invoice's carrying share; the difference is realised FX. TZS credits can now
be applied too (previously they could not be used at all).

**Currency confinement.** Sales, customer receipts, sales returns, expenses,
other income, cash transfers, stock transfers, stock adjustments and rebag
orders have **no currency columns** (always TZS, test-asserted). Foreign
payables may only originate from purchases (constraint). Cost invoices
(import service charges) are constrained to TZS — foreign import-origin
charges must go through the purchase invoice path. Existing bank / cash
accounts remain TZS.

**Retry safety.** Foreign postings require an idempotency key; a replay of
the same key returns the same document without posting again (checked
before the status check). Server actions use stable per-document keys
(`post_purchase:<id>`, `post_purchase_return:<id>`,
`post_supplier_payment:<id>`); the payment form sends one request id per
submission (`supplier_payments.client_request_id`, unique), so a retried
"create and post" finds the first payment instead of creating another;
credit applications and revaluations carry request ids from their forms.

**Defect fixes carried in this stage.** Purchases now receive stock at the
exact TZS value posted (`record_stock_movement_value`), so stock value always
equals the inventory debit (previously qty × rounded unit cost could differ by
cents). `void_purchase` now mirrors the posting journal exactly and posts the
difference between the original inventory value and the stock removed at
current average to 5300 — fixing D1 for purchases (TZS and foreign);
purchase-return voids restore stock at the exact cost removed. Voids also
check that the void date's period is open (part of D6). D1 for openings and
adjustments, D2–D5 remain for Stage 2b.

### Screens

- Purchases → Create Purchase: currency, rate (TZS per 1), "use table rate",
  rate reference, prices in the invoice currency with TZS preview, advance
  application; payments section hidden for foreign invoices.
- Purchase page: currency, rate and source; foreign and TZS line amounts;
  open foreign balance and TZS carrying; foreign balance history; apply
  supplier credits.
- Supplier Payments → Record: invoice currency; open invoices with foreign
  balance and TZS carrying; foreign amount to settle; TZS actually paid;
  advance; bank charges; FX preview.
- Purchase return: foreign purchases offer reduce-payable or supplier credit
  only; value shown in both currencies.
- Accounting → FX Revaluation: open balances per currency (invoices and
  credits, foreign and carrying), closing rates with source and reference,
  effect preview, post; history with void.
- Reports: Payables ageing shows currency and open foreign amount per invoice
  plus per-currency foreign totals; the TZS total uses carrying amounts and
  still reconciles to 2110 (TZS ageing now also deducts advances and credits
  applied). Supplier statement: one TZS statement plus one statement per
  foreign currency in that currency, with the TZS carrying amount of open
  invoices — USD and TZS are never added together.

### Acceptance fixture (actual results)

| Step | Expected | Result |
| --- | --- | --- |
| Invoice USD 100,000 @ 2,600 | TZS 260,000,000 invoice and payable; Dr 1150 / Cr 2110 | pass |
| Settle USD 40,000 for TZS 105,200,000 | release 104,000,000; FX loss 1,200,000; remaining USD 60,000 carries 156,000,000 | pass |
| Revalue at 2,650 | carrying 159,000,000; further 3,000,000 unrealised loss | pass |
| Later settlement of USD 60,000 for TZS 162,000,000 (+ TZS 25,000 bank charges) | releases 159,000,000 (updated carrying); realised loss 3,000,000; charges 6200 | pass |
| No double counting | realised 4.2M + unrealised 3M = TZS paid 267.2M − original 260M | pass |
| Inventory | unchanged by any FX difference; 1150 = stock subledger | pass |

### Checks actually run (21/10/2026)

| Check | Result |
| --- | --- |
| `npm run test:db` clean install (0001–0026) + seed + re-seed | pass |
| Existing Phase 2 / 3 / 4 suites (TZS purchasing, payments, returns re-implemented) | 19 / 26 / 11 pass |
| Stage 0 / Stage 2 suites | 51 / 114 pass (one Stage 2 check updated: Stage 3 intentionally allows purchase-origin foreign invoices) |
| **Stage 3 suite** (`scripts/itest-import3.ts`) — acceptance fixture; gates (flag, `fx.enter_rate`, key, rate source, rate-table match, zero / TZS rates, no instant payments on foreign invoices); immutability of posted rate and lines; retries of purchase, payment, revaluation and credit application (no duplicate journals or stock); USD advance applied at historical TZS with no FX; advance limits; payment with applied advance not voidable; foreign returns before and after revaluation (unrealised reversal); credit creation and application with realised gain; currency mismatches rejected both ways; TZS advance and partial payment; currency confinement (9 tables, cost invoices, expense payables); voids of the final settlement, a return, a foreign purchase with advance; revaluation void blocked by dependants; every journal balanced; 2110 = payable carrying, 1175 = unapplied advances, 1170 = credit carrying, 1150 = stock; event log reproduces every foreign balance | **79 pass** |
| Upgrade path (pre-0024 data → 0024 + 0025 + 0026) | 20 pass |
| Mutation: revaluation not updating carrying | 8 checks failed as expected (incl. the double-counting check); restored |
| `npm test` (calc + attachment policy) | 7 + 25 pass |
| `npm run typecheck`; ESLint on all Stage 3 files | pass (pre-existing lint errors in untouched `src/lib/reports/queries.ts` and two other report pages) |

**Not run / limitations:** the new screens were not opened in a browser
(sign-in is against the live Supabase project, out of bounds here); PGlite is
single-connection, so concurrent posting races were not executed (row locks
and keys reviewed); migration 0026 was not applied to the live database;
new permission `fx.enter_rate` and role grants reach the live database only
when the seed is re-run there. Not implemented in this stage: voiding a credit
application; cash refunds of foreign returns; applying an advance to an
already-posted invoice (by design); FX revaluation of advances (non-monetary,
by design); a foreign-currency bank ledger (out of scope).

---

## Stage 2 — Shared foundations and secure posting (implemented)

Migration `supabase/migrations/0025_import_foundations.sql` (additive). No
existing posting function was changed; nothing new is reachable from the UI
except Admin → Feature Flags; every new workflow function refuses to run
while its feature flag is off (default **off** for every company).

### What was added

**Secure posting primitives** (all `security definer`, execute revoked from
`anon` / `authenticated`, callable only by the server's service role):

| Function | Purpose |
| --- | --- |
| `assert_actor(user, company, permission, branch)` with `_user_can`, `_user_has_company`, `_user_has_branch` | RPCs no longer trust `p_user` blindly: active user, company access, permission and branch are checked inside the database (SQLSTATE 42501). |
| `claim_operation(key, operation, document)` | Strict idempotency: key ≥ 16 chars required; a replay of the same operation on the same document returns `false`; reusing a key for anything else raises. |
| `post_balanced_journal(...)` | Wraps `create_journal`: period must be open, every account must belong to the company and be an active posting account, amounts non-negative with ≤ 2 decimals, at least two lines, non-empty. |
| `lock_stock_balances(company, keys)` | Locks (creating if needed) all `stock_balances` rows a posting will touch, in (branch, product) order, after checking they belong to the company — deadlock-free ordering for multi-line postings. |
| `allocate_amount(total, basis, targets)` | Allocation engine: `direct`, `weight`, `value`, `volume`, `quantity`, `percent`, `manual`. Rejects zero denominators, negative / missing factors, duplicate targets, percentages outside 0–100 or not totalling exactly 100, manual amounts not equal to the total, totals with > 2 decimals. Largest-remainder rounding in cents (ties: larger factor, then id) — results always sum exactly to the total, signs preserved for credits. |
| `allocate_cost_source(source, kind, amount, basis, targets, user, key)` | Locks the cost source, checks feature flag + actor + idempotency, reads factors (net kg / value / quantity / volume) **from the database**, rejects targets that are not the source document's own lines, writes an insert-only allocation run and verifies conservation. Expensed costs cannot be allocated to stock. |
| `register_supplier_invoice(...)` + `supplier_invoice_registry` | One supplier invoice number (normalised by the existing `norm_invoice`) per supplier across purchases and cost invoices. Posted purchases were back-filled; future purchase postings register via trigger; voiding frees the number. |
| `account_for(company, key)` + `account_mappings` | New workflows resolve accounts by mapping key. 19 keys seeded idempotently from existing accounts; each mapping is type-checked and company-checked. |
| `feature_enabled` / `assert_feature` + `feature_flags` | `imports`, `rebagging`, `transfer_logistics`, `attachments`, `fx_settlement`; all off by default; Admin → Feature Flags. |

**Accounts.** Only two new accounts: 1145 Claims Receivable and 1175 Supplier
Advances (Imports). Bulk, packaged and packaging inventory **map to the
existing 1150** — no duplicate inventory control account. No rebagging
clearing account is needed (rebagging moves value within 1150; abnormal loss
maps to 6300). Mappings: `inventory.{standard,bulk,packaged,packaging}` →
1150, `transfer.goods_in_transit` → 1155, `import.goods_in_transit` → 1157,
`import.gr_ir` → 2130, `import.accrued_costs` → 2140,
`import.supplier_advances` → 1175, `import.claims_receivable` → 1145,
`fx.realised_{gain,loss}` → 4400/6400, `fx.unrealised_{gain,loss}` → 4410/6410,
`inventory.loss` → 6300, `inventory.cost_of_sales` → 5100,
`inventory.price_variance` → 5300, `tax.input_vat` → 1160,
`payables.trade` → 2110. A changed mapping affects future postings only.

**Schema** (all with `company_id`, `check_company_consistency` on every
foreign key, RLS read-by-company, no client write privileges):

- Imports: `import_shipments` (incoterm, explicit `goods_includes_freight` /
  `goods_includes_insurance`, currency, title date, separate
  `logistics_status` and `cost_status`, unique bill of lading per company),
  `import_shipment_lines` (net kg > 0, gross ≥ net, optional volume, FC price
  ≥ 0), `import_receipts` / `import_receipt_lines` (received, shortage,
  damage, resolution).
- Foreign purchase fields on the **existing** `purchases` / `purchase_lines`:
  `import_shipment_id`, `posting_mode` (`stock_on_post` default = today's
  behaviour; `invoice_only`), `currency_code`, `exchange_rate > 0` (TZS ⇒ 1),
  FC totals ≥ 0, `fc_unit_cost`, `import_shipment_line_id`. Foreign currency is
  only allowed on an import-linked `invoice_only` purchase whose supplier and
  currency match the shipment. An `invoice_only` purchase **cannot be posted
  by the legacy `post_purchase`** (guard trigger) until Stage 3 provides its
  posting function.
- Costs: `cost_sources` (owner = shipment / transfer / rebag order; status
  estimated → accrued → invoiced / voided; non-negative amounts), with the
  category's treatment, expense account, commercial flag and basis
  **snapshotted** at creation and frozen once accrued — editing a category
  default never changes an old posting. Freight / insurance categories are
  rejected on shipments whose goods value already includes them. The goods
  value cannot be a cost source. `cost_invoices` / `cost_invoice_lines`
  (credit adjustments are explicit `credit_note` documents with positive
  amounts that must credit an invoice of the same supplier; a posted cost
  invoice cannot be edited), `cost_source_actuals` (one invoice line per cost
  source), `cost_allocation_runs` / `cost_allocations` (insert-only; a new run
  supersedes; one current run per source and kind).
- `supplier_payables` gains `cost_invoice_id`, `currency_code`, `fc_original`,
  `fc_outstanding` (0 ≤ outstanding ≤ original); the "exactly one source"
  check now includes cost invoices.
- Packages and rebagging: packaged products must use a whole-number unit;
  `rebag_orders` (bulk product only), `rebag_outputs` (integer bags,
  net kg = bags × pack kg, packaged SKU filled from the order's bulk product),
  `rebag_inputs` (bulk input = the order's bulk; packaging input must be a
  packaging material aimed at an output of the same order).
- Provenance: `stock_lots`, `stock_lot_balances`, `stock_lot_flows`
  (quantity only; maintained from Stage 2b / 3).
- Transfers: `stock_transfers` gains transporter / driver / vehicle (master +
  snapshot fields), agent, ready / closed stamps, `cost_status`,
  `has_open_discrepancy`; status adds `ready` and `closed` (existing values
  unchanged); `stock_transfer_lines.company_id` (back-filled) with a
  same-company product check; `drivers`, `vehicles` (unique registration per
  company); `stock_transfer_receipts` / `…_lines` for partial receipts with
  short / damaged quantities and resolution.
- Documents: `document_attachments` (company, owner type + id, category,
  uploader, version, supersedes, timestamp, SHA-256, size, type, safe
  download name; **insert-only** — updates and deletes are blocked, a
  replacement is a new version, each version can be superseded once) and
  `document_versions` (insert-only snapshots of generated documents).

**Attachments (application layer).** `src/lib/attachments/policy.ts`
(pure rules), `service.ts` (server-only), `actions.ts` (server actions,
require the `attachments` flag):

- Private bucket `documents` created by the migration on Supabase (skipped
  where no `storage` schema exists, e.g. PGlite) with a 10 MB limit and an
  allow-list of PDF, JPEG, PNG, WebP. **No `storage.objects` policies** are
  created, so browsers cannot list, read or write objects directly; only the
  server (service role) touches Storage, after the checks below.
- Upload: declared type must be allowed **and** the file's leading bytes
  must match it (HTML, SVG, scripts or executables renamed to `.pdf` are
  rejected); size ≤ 10 MB; object key `company/owner_type/owner_id/<uuid>.ext`
  never contains the user's file name; `upsert: false`; metadata registered
  through `register_attachment`, which re-checks the flag, `documents.upload`,
  the parent record (company, view permission, branch — transfers: sender or
  receiver branch), financial categories (`documents.view_financial`), and
  that the storage path belongs to that parent. If registration fails the
  just-uploaded object is removed.
- Download: parent-record check + financial-category check, then a signed
  URL valid for **60 seconds** created with `download: <safe name>`
  (Content-Disposition: attachment — never rendered inline). Uploads and
  downloads are written to the audit log.

**Permissions.** New codes: `imports.{view, create, edit_draft, post,
receive, approve, void, view_cost, finalize_cost}`, `cost_invoices.{view,
create, post, void}`, `rebagging.{view, create, post, void}`,
`documents.{view_financial, upload}`, `fx.{settle, revalue}`,
`inventory.{transfer_view, transfer_resolve}`. `imports.receive` is separate
from `imports.post` so a Storekeeper (who holds `purchases.post`) can receive
goods without being able to post foreign goods invoices. Role grants:
Director (imports, cost invoices, rebagging, transfer view/resolve,
documents, FX settle), Accountant (import view/cost/finalize, cost
invoices, documents, FX settle/revalue), Storekeeper (imports view/receive,
rebagging, transfer view, upload), Auditor (read-only incl. costs). They take
effect when `npm run db:seed` is next run and remain inert while flags are off.

### Test harness additions

- `scripts/itest-import2.ts` (114 checks) — added to `npm run test:db`.
- `scripts/test-attachments.ts` (25 checks) — added to `npm test`.
- `scripts/testdb/upgrade-check.ts` now also posts a purchase with a supplier
  invoice number and a dispatched transfer through the real pre-upgrade
  functions before applying 0024 + 0025.

### Checks actually run (21/10/2026)

| Check | Result |
| --- | --- |
| Clean install: migrate (0001–0025) → seed → seed re-run → test owner | pass |
| Existing Phase 2 / 3 / 4 suites on the upgraded schema | 19 / 26 / 11 pass |
| Stage 0 suite | 51 pass |
| **Stage 2 suite** — allocation (exact sums, deterministic remainder, credits, percent/manual/volume/zero-denominator/duplicate/direct rules, **300 random cases** within one cent per target), validation (rates, FC-only-on-imports, legacy posting blocked, net/gross kg, negative amounts, CIF freight double-count, snapshots frozen after category edit, credit notes, posted-invoice edits, whole-number bags, kg = bags × pack weight, packaging targeting, bulk lineage), cross-company with guessed ids (supplier, product, shipment, category, cost source, account mapping, journal account, stock lock, transfer line, allocation targets, attachment owner), direct API (execute revoked on 8 RPCs for `authenticated` and `anon`; client inserts denied; other-company user sees nothing), actor checks (missing permission, no company, inactive user, feature flag off), idempotent allocation retry (same run, no second run), claim replay / key reuse, registry duplicates across purchase and cost invoice, journal balance / decimals / header account / closed period, mapping type check, attachment versioning, immutability, type/size/name/path rules, sender + receiver access and third-branch denial | **114 pass** |
| Upgrade path (pre-0024 database with committed stock, journals, a posted purchase and a dispatched transfer → apply 0024 + 0025): trial balance, stock balances, movements, journal lines, accounts, payment ledgers, products unchanged; 11 new accounts only; 19 mappings; 5 flags off; registry back-fill; transfer lines company back-fill; transfer status kept; existing purchases stay `stock_on_post`/TZS; duplicate invoice blocked | **20 pass** |
| Mutation: remainder cents dropped in `allocate_amount` | 4 checks failed as expected (incl. the random property test); restored |
| Mutation: cost-source cross-company trigger removed | 1 check failed as expected; restored |
| `npm test` (calc + attachment policy) | 7 + 25 pass |
| `npm run typecheck`; ESLint on changed files | pass |

**Not run / not verifiable here:** the Storage bucket statement and signed
URLs (PGlite has no Supabase Storage — the bucket block is skipped there, so
it has only been reviewed, not executed); true concurrent sessions (PGlite is
single-connection — ordering and locks were verified by code review and
sequential tests, not by racing transactions); the migration was not applied
to the live database; Admin → Feature Flags was not opened in a browser.

### Limitations and decisions carried forward

- D1–D5 from Stage 1 are **not** fixed by this stage (it adds new primitives
  without changing existing posting); they are Stage 2b and should land
  before Stage 3 posts import stock.
- Expenses have no supplier-invoice-number field, so the registry cannot stop
  an expense from re-using an import invoice number; Stage 3 will make
  import-related charges post only through cost invoices and can add an
  invoice-number field to expenses.
- Lot tables exist but nothing writes to them yet (Stage 2b / 3).
- Role grants for the new permissions reach the live database only when the
  seed is re-run there.

---

## Stage 1 — Investigation and design

Everything in this section marked **Verified** was read in the code or
reproduced on a throwaway PGlite database on 21/10/2026. Items marked
**Assumption** or **Decision needed** were not verified or need a business
answer. Nothing was applied to the live database.

### 1. Actual architecture

#### 1.1 Verification of the supplied overview

| Claim in the overview | Finding |
| --- | --- |
| Next.js 16, React 19, TypeScript, Tailwind, Vercel | **Verified** (`package.json`, `AGENTS.md`). |
| Supabase PostgreSQL + Auth | **Verified**. All app data access uses the service-role client (`src/lib/supabase/admin.ts`) after server-side checks; RLS is a read backstop (`0005_rls.sql`, `0010_phase2_rls.sql`, `0017`, `0022`). |
| Supabase **Storage** | **Not used anywhere** (no `storage.` / upload / signed-URL code in `src` or migrations). Stage 6 introduces it. |
| Multi-company and branch scope | **Partly.** Every table carries `company_id`; `check_company_consistency()` (`0001_foundation.sql`) blocks cross-company references. But the app resolves one company per user (`getPrimaryCompanyId(user.defaultCompanyId)` in `src/lib/context.ts`) — there is no company switcher. Branch scope is enforced in server actions (`assertBranchAccess`), **not in RLS** (`0010` header comment) and **not for transfer dispatch/receive/void** (D3). |
| Role permissions | **Verified**: 109 permission codes from `PERMISSION_DEFS` (`src/lib/auth/permissions.ts`), 6 roles, checked by `assertPermission` / `requirePermissionPage` (`src/lib/auth/guards.ts`). RPCs trust the `p_user` they are given and do not re-check permissions. |
| Automatic double-entry posting | **Verified**: every posting RPC builds lines and calls `create_journal()` (`0007_phase2_accounting.sql`), which rejects unbalanced journals. |
| Weighted-average cost, Kardex | **Verified**, scoped per company + branch + product (§2). Kardex page `src/app/(app)/inventory/kardex/page.tsx` reads `stock_movements`. |
| Permanent posted documents, reversal-based voiding | **Verified**: `journal_entries`, `journal_lines` and `stock_movements` have update/delete-blocking triggers (`0007`, `0006`); voids post reversing journals and movements. **But** several voids reverse stock at the *current* average and the GL at the *original* value (D1). |
| Immutable audit history | **Verified**: `audit_logs` update/delete triggers (`0004_audit.sql`); app writes via `writeAuditLog` (`src/lib/audit.ts`). |
| Closed accounting periods | **Verified**: `assert_period_open(company, date)` (`0009_phase2_rpc.sql`) raises for `closed`/`locked`. Voids check the *original document date* but date their journal `current_date` (UTC), so the void's own period is not checked (D6). |

#### 1.2 Components and where they live

| Area | Schema | Posting / logic | App |
| --- | --- | --- | --- |
| Purchases (receipt **and** invoice in one document) | `purchases`, `purchase_lines`, `purchase_payments` (`0014`) | `post_purchase` / `void_purchase` (`0015`): stock in at `round((net+non-recoverable tax)/qty,4)`; Dr 1150 (+6100 non-stock, +1160 recoverable VAT) / Cr payment ledgers + 2110 | `src/lib/purchases/actions.ts`, `src/app/(app)/purchases/*` |
| Supplier balances | `supplier_payables` (one row per purchase **or** expense, `0014`), `supplier_payments`, `supplier_payment_funding`, `supplier_payment_allocations`, `supplier_credits` | `post_supplier_payment` (Dr 2110 / Cr funding ledgers, overpayment + funds checks), `recalc_purchase` / `recalc_expense` | ageing + statements in `src/lib/reports/subledger.ts` |
| Purchase returns | `purchase_returns`, `purchase_return_lines`, `purchase_return_settlements` | `post_purchase_return` (`0018`): stock out at current average, difference to 5300 PPV | |
| Expenses | `expenses` (single category + tax), `expense_payments` | `post_expense` (`0015`): Dr category account (+1160) / Cr ledgers + 2110; credit expense requires supplier | `src/lib/expenses/actions.ts` |
| Tax | `tax_codes.is_recoverable`, rate, inclusive flag | Purchase lines snapshot `tax_rate`, `is_recoverable`; non-recoverable tax is capitalised for stock lines | |
| Inventory | `stock_balances` (projection), `stock_movements` (immutable ledger) (`0006`) | `record_stock_movement()` — the single valuation primitive | `src/lib/inventory/actions.ts` |
| Transfers | `stock_transfers`, `stock_transfer_lines` (`0008`) | `dispatch_stock_transfer` (whole requested qty, out at source average, **no journal**), `receive_stock_transfer` (partial, in at dispatch unit cost), `void_stock_transfer` (`0009`) | `src/app/(app)/inventory/transfers/*` |
| Journals | `journal_entries` (`source_type`, `source_id`), `journal_lines` | `create_journal()`; `account_id_by_code()` resolves system accounts by code | |
| Reconciliation | `bank_reconciliations` etc. (`0019`) | subledger vs control: AR/2110 AP/1150 inventory/journal balance (`reconciliationControls` in `subledger.ts`) | |
| Period close | `accounting_periods`, `accounting_period_close_checks` | `runPeriodChecks` (`src/lib/accounting/actions.ts`): drafts, negative stock, open transfers (warning), **control differences (blocking)** | |
| Document numbering | `document_sequences` (company or branch scoped) | `next_document_number()` locks the sequence row. `reset_frequency` is stored but **never applied** (D7). | |
| Idempotency | `idempotency_keys(key)` | `claim_idempotency()`; server actions pass `randomUUID()` per call (D4) | `src/lib/rpc.ts` |
| Tests / migrations / seed | — | `scripts/migrate.ts` (ordered, tracked), `scripts/seed.ts` (+ `ensure_company_defaults` since 0024), `scripts/itest*.ts`, `npm run test:db` (PGlite) | |

#### 1.3 Defects found that the upgrade depends on

| # | Defect | Evidence |
| --- | --- | --- |
| D1 | Voids that remove stock post the stock movement at the **current** average but credit 1150 with the **original** value: `void_purchase`, `void_inventory_opening`, `void_stock_adjustment` (increase). Permanent stock-subledger vs GL drift. | Reproduced: buy 10 @ 100 and 10 @ 200, void the first → stock 1,500 vs GL 2,000 (**−500**). |
| D2 | Transfer dispatch removes value from the source subledger with no journal; value reappears only on receipt. While goods are in transit the inventory control shows a difference, which `runPeriodChecks` treats as **blocking** for period close. `void_stock_transfer` also returns stock at different costs on each side with no journal. | Reproduced: dispatch 4 bags → stock 900 vs GL 2,000 (−600 in transit on top of D1). |
| D3 | `dispatchTransfer`, `receiveTransfer`, `voidTransfer` check permission but not branch; the list page shows every company transfer and requires `inventory.transfer_create` even to look. | `src/lib/inventory/actions.ts` lines 241–286; `src/app/(app)/inventory/transfers/page.tsx`. |
| D4 | Idempotency keys are generated per call (`randomUUID()`), so a retried or double-submitted request is a new operation. Status checks under `for update` stop double posting of one-shot documents, but repeatable operations (partial transfer receipts) can be applied twice. | Code reading; repeat receipts with new keys were accepted in the PGlite run (bounded only by dispatched qty). |
| D5 | When a balance reaches zero quantity, `record_stock_movement` sets `stock_value = 0` but returns `round(qty × avg, 2)`; any rounding residual stays in GL 1150. | `0006_phase2_inventory.sql` lines 150–155. |
| D6 | Void journals are dated `current_date` (database UTC) while the period check uses the original document date. | All `void_*` functions. |
| D7 | `document_sequences.reset_frequency` is never used; seed sets `yearly` but numbers never reset. | `next_document_number()`. |
| D8 | Historical inventory valuation and Kardex cut-offs use UTC day boundaries (`asOf + "T23:59:59Z"`), not Africa/Dar_es_Salaam. | `subledger.ts` line 180. |

D1, D2, D3, D4 and D5 are fixed in Stage 2 before any import cost is layered on
top; D6–D8 are recorded and fixed opportunistically.

### 2. Valuation scope and migration strategy

**Verified:** average cost is already **per company + branch + product**
(`stock_balances unique (company_id, branch_id, product_id)`, and every
`record_stock_movement` call passes the document's branch). It is **not**
company-wide, so no valuation-scope migration is needed, and no opening stock
value is reset or recreated.

Precision today: quantity `numeric(18,4)`, average `numeric(18,4)`, values
`numeric(18,2)`; outgoing value = `round(qty × avg, 2)`.

What the upgrade adds without changing valuation:

- **Provenance lots** (`stock_lots`, Stage 2) record *where stock came from*
  (shipment line, rebag output, transfer) and how much of each lot is held at
  each branch. They carry **quantity only, never value**; value stays in
  `stock_balances`. This keeps weighted average and avoids FIFO /
  specific-identification valuation.
- Existing stock is not given a fabricated origin. The Stage 2 migration
  creates, for each existing `(company, branch, product)` with quantity > 0,
  one **untracked lot** holding exactly the current quantity, so pro-rata
  depletion (below) stays correct for blended stock.
- D1/D5 fixes change future postings only; past drift (if any on the live
  database) is reported by the reconciliation control and cleared by an
  approved adjustment journal, never by rewriting history.

### 3. Integrated data model

Principle: extend existing tables where the concept already exists; add new
tables only for concepts the system lacks. All new tables follow the 0005/0010
RLS model, `check_company_consistency` triggers on every FK, numeric money and
quantity types, and Admin/server-action writes via service role.

```
suppliers ──< import_shipments ──< import_shipment_lines >── products (bulk / standard)
                │                         │
                │                         ├──< purchase_lines (goods invoice, extended)  ── purchases (extended: FC, invoice_only)
                │                         └──< import_receipt_lines >── import_receipts (GRN, per branch)
                │                                      │
                ├──< cost_sources ──< cost_allocations ┘ (targets: shipment line / receipt line / transfer line / rebag output)
                │        │
                │        └──< cost_invoice_lines >── cost_invoices (service suppliers) ──> supplier_payables (extended)
                │
stock_lots ──< stock_lot_balances (company, branch, product, lot, qty)
    │  └──< stock_lot_flows (movement_id, from_lot, to_lot, qty, cost_delta_applied)
    └── origin: import_receipt_line | rebag_output | transfer_receipt_line | untracked

rebag_orders ──< rebag_inputs (bulk kg, packaging qty → target output) ──< rebag_outputs (packaged SKU, bags, kg)

stock_transfers (extended: logistics, cost_status) ──< stock_transfer_lines
        ├──< stock_transfer_receipts ──< stock_transfer_receipt_lines (received / short / damaged)
        └──< cost_sources (transfer charges)

document_attachments (owner_type, owner_id, kind, storage_path, version, supersedes_id)
document_versions    (owner_type, owner_id, kind, version, snapshot jsonb, content_hash)
drivers, vehicles    (master data; snapshot copied onto the dispatch)
supplier_invoice_registry (company, supplier, invoice_norm, source_type, source_id) unique
```

| Entity | Extends / new | Key columns and rules |
| --- | --- | --- |
| `import_shipments` | new | supplier (goods), document number (`IMP`), receiving branch, B/L / container / vessel refs, `incoterm`, **`goods_includes_freight`, `goods_includes_insurance`** (explicit, defaulted from incoterm, locked once a goods invoice posts), `currency_code`, `title_date` (ownership passes), ETA, `logistics_status`, `cost_status` |
| `import_shipment_lines` | new | product (bulk or standard), ordered qty in product unit, **net kg**, gross kg, optional volume m³, FC unit price, tax code |
| Goods invoice | **extend `purchases` / `purchase_lines`** | `import_shipment_id`, `posting_mode` (`stock_on_post` = today's behaviour, default; `invoice_only` = no stock movement), `currency_code`, `exchange_rate` snapshot, FC subtotal/tax/total; `purchase_lines.import_shipment_line_id`. DB check: FC only when `import_shipment_id` is set. Payables, payments, statements and ageing keep working through `supplier_payables`. |
| `supplier_payables` | extend | `currency_code`, `fc_original`, `fc_outstanding`, `cost_invoice_id`; the "exactly one source" check gains `cost_invoice_id`. |
| `supplier_payments` / allocations | extend | `currency_code`, `fc_amount` per allocation, `tzs_debited` (funding stays TZS ledgers), realised FX amount. |
| `cost_sources` | new | owner (exactly one of shipment / transfer / rebag order), `cost_category_id`, service supplier, `status` (`estimated`, `accrued`, `invoiced`, `voided`), estimate, accrued and actual TZS amounts, allocation basis override. |
| `cost_invoices`, `cost_invoice_lines` | new | supplier invoice for services (port, clearing, transport…), multi-line by cost category, tax per line, optional FC (Decision 5). Each line links to at most one `cost_source`; a cost source can be actualised by **one** posted line (partial unique index). Creates a `supplier_payables` row. |
| `supplier_invoice_registry` | new | `(company, supplier, norm_invoice)` unique across purchases, expenses (when an invoice number is entered) and cost invoices — prevents the same invoice being posted through Purchases, Expenses and Importation. |
| `cost_allocations` | new | cost source → target row, basis, basis quantity, allocated amount; Σ allocated = source amount enforced on posting. |
| `import_receipts`, `import_receipt_lines` | new | branch, received qty, received kg, shortage kg, damaged kg, resolution (§6), lot created. Several receipts per shipment. |
| `stock_lots`, `stock_lot_balances`, `stock_lot_flows` | new | provenance only (§2, §7). |
| `rebag_orders`, `rebag_inputs`, `rebag_outputs` | new | inputs: bulk kg consumed; packaging material qty with **`target_output_id`**; outputs: packaged SKU, bags, net kg = bags × `net_weight_kg`; normal / abnormal loss kg; unused bulk simply stays in stock. |
| `stock_transfers` | extend | `cost_status`, transporter (supplier), driver/vehicle ids + **snapshot** fields, agent, `ready_by/at`, dispatched kg; one dispatch per transfer. |
| `stock_transfer_receipts`, `…_lines` | new | per partial receipt: received, short, damaged, receiver, POD attachment, resolution. Replaces in-place `qty_received` increments (kept as a derived total). |
| `document_attachments` | new | private Storage bucket path, SHA-256, `version`, `supersedes_id`, uploader; rows immutable. |
| `document_versions` | new | snapshot JSON of generated documents (delivery note, GRN) per issued version, so a reprint shows exactly what was signed. |
| `drivers`, `vehicles` | new | master data; transporters, clearing agents and forwarders stay `suppliers` (they invoice us) with role flags. |
| Packaging materials | existing `products` | `stock_role = 'packaging_material'` (Stage 0); stocked and costed like any product. |

### 4. Transaction / posting matrix

Amounts are TZS. "Stock" = `stock_movements` at a branch (physically saleable
stock exists only after a receipt). **Ownership/control** is recognised from
the shipment's `title_date` — paying an invoice never creates stock.

| # | Document / event | Physical stock | Debit | Credit | Payable / accrual | FX effect | Reversal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Shipment confirmed | none | — | — | — | — | cancel (no postings) |
| 2 | Supplier advance (before title and invoice) | none | 1175 Supplier advances (TZS actually debited) | bank ledger | — | none; non-monetary at payment rate | void payment |
| 3 | **Title passes** (`title_date`) | none (goods in transit) | 1157 Import GIT: goods value (FC × rate on title date; prepaid share at advance TZS) | 2130 GR/IR | liability recognised | rate fixed here | reversing journal, blocked once any receipt posts |
| 4 | Goods invoice posted (`purchases`, `invoice_only`, FC) | none | 2130 GR/IR (accrued TZS for matched qty) ± difference (§7) ; 1160 recoverable import VAT if any | 2110 AP (FC carrying TZS); 1175 if advance applied | payable in FC + TZS carrying | invoice before title: AP at invoice-date rate and title then credits 2130 at the same TZS | void → reverse; blocked if paid |
| 5 | Cost estimate | none | — | — | — | — | edit / void |
| 6 | Cost accrual (capitalised category, no invoice yet) | none | 1157 before receipt; included in receipt cost after | 2140 | accrued | — | reversed when actual posts |
| 7 | Cost invoice posted (`cost_invoices`) | none | capitalised: 2140 (matched accrual) ± delta (§7); expensed: category expense account; 1160 recoverable VAT | 2110 AP (or ledger if paid now) | payable | only if Decision 5 allows FC | void = negative delta via §7 |
| 8 | Goods receipt (GRN) at branch | **+qty at branch**, lot created | 1150 (goods + capitalised costs for received share) | 1157 | — | — | allowed only while the lot is untouched (§6) |
| 9 | Receipt shortage / damage resolution | adjust | normal (within tolerance): stays in 1150 (spread); abnormal: 6300; claim: 1145 Claims receivable | 1157 | — | — | reverse resolution |
| 10 | FC supplier payment | none | 2110 at carrying TZS of settled FC | bank (actual TZS debited) | reduces FC + TZS outstanding | difference → 6400 loss / 4400 gain | void reverses incl. FX |
| 11 | Period-end FC revaluation | none | 6410 or 2110 | 2110 or 4410 | carrying adjusted | unrealised; auto-reversed on day 1 of next period | automatic |
| 12 | Rebagging posted | bulk −kg, packaging −qty, outputs +bags; unused bulk stays | 1150 outputs; 6300 abnormal loss | 1150 inputs; 2140 accrued conversion cost | — | — | only if outputs untouched |
| 13 | Transfer dispatch | source −qty | 1155 GIT (source average value); 1155 accrued charges | 1150; 2140 | — | — | void while nothing received |
| 14 | Transfer receipt (partial) | destination +qty | 1150 (dispatch cost + charges per unit) | 1155 | — | — | per receipt, if untouched |
| 15 | Transfer shortage resolution | — | normal: 1150 (absorbed); abnormal: 6300; claim: 1145 | 1155 | — | — | reverse resolution |
| 16 | Sale / return | existing behaviour (branch average) + lot pro-rata flows | — | — | — | — | existing |
| 17 | Late cost delta | none (qty unchanged) | 1150 held / 5100 sold / 6300 written off / 1155 in transit (+ or −) | 2140 / 2110 | — | — | negative delta |

Same-company only: every new document carries one `company_id`, and branches,
products, suppliers and accounts are checked by `check_company_consistency`.
Cross-company movement is rejected (no intercompany process exists today).

### 5. Cost-allocation policy

1. **Direct assignment first** — a cost source attached to one shipment line,
   receipt line, transfer line or rebag output goes entirely to it.
2. Otherwise by the cost category's **allocation basis** (or a per-source
   override): **net kg** (default for freight, port, clearing, transport),
   **purchase value** (TZS goods value: insurance, duty, levies),
   **quantity/bags** (rebag labour), **volume m³** only when captured on every
   target (otherwise rejected, not guessed), or **explicit** amounts typed by
   the user that must sum to the source.
3. **Packaging materials go only to their real outputs**: each packaging input
   on a rebag order names its `target_output_id` (50 kg bags → 50 kg output).
4. Freight/insurance categories are refused on a shipment whose goods value
   already includes them (`goods_includes_freight/insurance`).
5. Expensed categories are never allocated to stock (shown in the commercial
   view only).
6. Arithmetic in PostgreSQL `numeric`: shares computed at 10 dp, rounded to
   0.01, and the **largest-remainder** method puts the residual cents on the
   largest share, so Σ allocations = source amount exactly.

### 6. State machines

Logistics and costing are separate columns, so a late invoice changes
`cost_status` only and never reopens received cargo.

**Shipment logistics:** `draft → ready → dispatched → partially_received →
received → closed`. `cancelled` only from draft/ready (no postings). A receipt
with shortage or damage puts the shipment in `received` with an **open
discrepancy**; it cannot move to `closed` until an approver records a
resolution (normal loss / abnormal write-off / claim).

**Transfer logistics:** same states (existing `draft / dispatched /
partially_received / received / voided` map directly; `ready` and `closed`
added). Void allowed only before any receipt; afterwards corrections use
receipt reversal or a reverse transfer.

**Cost status (shipment, transfer, rebag order):**
`estimated` (estimates only) → `provisional` (accruals posted, actuals
missing) → `finalized` (approver confirms all sources are actual) →
`adjusted` (a delta posted after finalization; stays `adjusted`).

**Cost source:** `estimated → accrued → invoiced`; `voided` from
estimated/accrued; an invoiced source changes only through a delta.

**Rebag order:** `draft → posted → voided` (void only while outputs are
untouched).

**Reversal dependency rule:** a receipt, rebag or transfer receipt can be
reversed only while its lots are untouched (`stock_lot_flows` shows no
outflow from them). Otherwise the void is rejected with the list of
dependent documents (a coordinated reversal plan).

### 7. Late cost propagation (weighted average kept)

Goal: a cost delta *D* that arrives after goods were received reaches every
place the goods went, in the current open period, without lot valuation.

**Data maintained from Stage 2 onward**

- Every stock movement of a lot-tracked product writes `stock_lot_flows` rows.
  Outflows from `(company, branch, product)` deplete that location's lots
  **pro-rata to their current quantities** (largest remainder at 4 dp). This is
  the quantity view of weighted-average blending: each unit sold from a blended
  pool contains each lot in proportion.
- Transfers move lot quantity to the destination (lot identity kept; transit
  quantity tracked on the transfer line). Rebagging consumes bulk lots and
  creates output lots linked by `stock_lot_flows(from_lot → to_lot)` with the
  kg consumed.

**Algorithm `propagate_cost_delta(source, D, posting_date)`** (one database
transaction):

1. Lock in fixed order: cost source → owning document → affected lots (id
   ascending) → `stock_balances` rows (company, branch, product ascending).
   Require `assert_period_open(posting_date)`.
2. Allocate *D* to target lots by §5 → `d_lot` (sums exactly to *D*).
3. For each lot λ with original quantity Q0: per-unit delta `u = d_lot / Q0`
   (numeric, 10 dp). Walk the flow graph forward from λ, accumulating:
   - held at branch b (`stock_lot_balances`): `u × held` → target
     `(b, product, inventory)`;
   - in transit on an open transfer line: `u × in_transit` → 1155 and the
     transfer line's unit cost, so the receipt picks it up;
   - sold (sale flows − sales-return flows): `u × net_sold` → 5100;
   - written off / abnormal loss / shrinkage flows: → 6300;
   - consumed by rebagging: `u × kg_consumed` is re-allocated to the output
     lots by the order's original costing basis (net kg, normal loss absorbed,
     abnormal-loss share → 6300), giving each output lot μ its own
     `u_μ = share / bags_produced_μ`; recurse from step 3 for μ;
   - transferred: recurse at the destination branch with the same `u`.
4. Round every target amount to 0.01; put the residual on the largest target so
   Σ targets = *D*.
5. For each inventory target post a **`cost_adjustment`** stock movement
   (qty 0, value ± amount); the new average is `(stock_value + Δ) / quantity`.
   If Δ would make a location's value negative, the excess goes to 5100.
   If the location now holds zero quantity, the whole amount goes to 5100.
6. One journal dated `posting_date`: Dr/Cr 1150 per branch, 1155, 5100, 6300;
   contra Cr/Dr 2140 (matched accrual) and/or 2110 (actual payable).
   Increment `stock_lot_flows.cost_delta_applied` for every flow touched.
7. Set the owning document's `cost_status = 'adjusted'` if it was finalized.

**Sales returns** restore quantity to the lots the original sale took, and
value at the original sale unit cost **plus** the share of
`cost_delta_applied` recorded on that sale's flows (Dr 1150 / Cr 5100), so a
returned unit carries the late cost too.

**Closed periods** are never re-posted: all deltas use the current open
period's date, referencing the original documents. A "late cost adjustments"
report lists deltas whose original sales fell in closed periods.

**Worked example (fixture F1).** 100,000 kg urea received at HQ at TZS 1,000/kg.
Rebag 40,000 kg → 800 × 50 kg; transfer 300 bags to Mwanza; HQ sells 200 bags
and 10,000 kg bulk; Mwanza sells 100 bags. A late port invoice adds
D = TZS 5,000,000 (by net kg → u = 50/kg):

| Where | Quantity | Amount | Account |
| --- | --- | --- | --- |
| HQ bulk held | 50,000 kg | 2,500,000 | 1150 (HQ, bulk) |
| HQ bulk sold | 10,000 kg | 500,000 | 5100 |
| Bags (40,000 kg → 800 bags, 2,500/bag): HQ held | 300 bags | 750,000 | 1150 (HQ, 50 kg) |
| HQ bags sold | 200 bags | 500,000 | 5100 |
| Mwanza bags sold | 100 bags | 250,000 | 5100 |
| Mwanza bags held | 200 bags | 500,000 | 1150 (MWZ, 50 kg) |
| **Total** | | **5,000,000** | Cr 2110 / 2140 |

### 8. Role / branch action matrix

New permission codes (added to `PERMISSION_DEFS`):
`imports.{view, create, edit_draft, post, approve, void, view_cost, finalize_cost}`,
`cost_invoices.{view, create, post, void}`, `rebagging.{view, create, post, void}`,
`inventory.transfer_view`, `inventory.transfer_resolve`, `fx.{settle, revalue}`,
`documents.{view_financial, upload}`. Existing `inventory.transfer_*` and
`transactions.void` stay.

| Action | Permission | Branch rule (checked in server action **and** RPC) |
| --- | --- | --- |
| View shipment (logistics) | `imports.view` | receiving branch or Owner |
| View FC values, costs, cost invoices | `imports.view_cost` / `cost_invoices.view` | company |
| Create / post goods invoice | `purchases.post` + `imports.post` | company |
| Post cost invoice | `cost_invoices.post` | company |
| Record goods receipt | `imports.post` | user has the receiving branch |
| Resolve receipt / transfer discrepancy | `imports.approve` / `inventory.transfer_resolve` | must not be the receiver |
| Finalize costs | `imports.finalize_cost` | company |
| Rebag | `rebagging.post` | user has the rebag branch |
| Create transfer | `inventory.transfer_create` | user has source branch |
| View transfer (incl. in transit) | `inventory.transfer_view` | user has **source or destination** branch |
| Dispatch | `inventory.transfer_dispatch` | user has source branch |
| Receive | `inventory.transfer_receive` | user has destination branch and **is not the dispatcher** (Owner override logged — Decision 8) |
| See transfer charges / unit costs | `inventory.view_cost` | as view |
| Void / reverse | `transactions.void` | user has the document's branch(es) |
| Cross-company anything | — | rejected by FK consistency triggers and RPC checks |

RPCs stop trusting `p_user` blindly: new helpers
`_user_can(p_user, permission)` and `_user_has_branch(p_user, branch)` are
called inside every new posting function, so a direct service-role call with
the wrong user still fails.

**Attachments** (private bucket `documents`, no client Storage policies; the
server checks access and issues short-lived signed URLs):

| Kind | Who can read | Who can upload |
| --- | --- | --- |
| Bill of lading, packing list, customs entry | shipment viewers | `imports.create` |
| Supplier / cost invoices | `documents.view_financial` | `cost_invoices.create` |
| Delivery note (generated, versioned) | transfer viewers (both branches) | system on dispatch |
| Signed POD, receipt photos | transfer viewers (both branches) | receiver (destination branch) |

Rows are immutable; a new upload supersedes the previous version, which stays
readable for audit.

### 9. Implementation plan, policies and fixtures

**Routine choices fixed here** (no business input needed):

- Precision: quantities and kg `numeric(18,4)`; TZS and FC amounts
  `numeric(18,2)`; rates `numeric(18,6)`; intermediate allocation and
  per-unit deltas `numeric(28,10)`; largest-remainder rounding.
- Lock order: document → cost sources → lots (id) → `stock_balances`
  (company, branch, product); new multi-line postings sort lines by product.
- Idempotency: forms generate one request id per submission; server actions
  pass it through; new RPCs require a non-null key scoped as
  `operation:document:key`.
- One dispatch per transfer; many receipts.
- FC revaluation: period-end journal auto-reversed on the first day of the
  next period.
- Rate used for goods cost: the rate on the date the liability is first
  recognised (title or invoice, whichever is first); prepaid shares keep the
  advance's TZS (non-monetary).
- Transporters, clearing agents and forwarders are suppliers; drivers and
  vehicles are master data snapshotted onto each dispatch.
- Delivery notes and GRNs are printable pages (like the existing invoice /
  receipt pages) backed by `document_versions` snapshots.
- New accounts needed later: 1145 Claims Receivable, 1175 Supplier Advances
  (added through `ensure_company_defaults`).

**Material business decisions (need an answer before the stage that uses them):**

| # | Decision | Recommendation | Needed by |
| --- | --- | --- | --- |
| 1 | When does ownership pass (title date) per incoterm? | Record explicitly per shipment; default B/L date for CIF/CFR/FOB, arrival for DAP/DDP | Stage 3 |
| 2 | Rate for inventory cost | First recognition date (above) | Stage 3 |
| 3 | Transit / receipt loss tolerance per product and treatment of shortages | e.g. ≤ 0.5 % normal (absorbed), above → write-off or claim with approval | Stage 3, 6 |
| 4 | Capitalise inter-branch transport? | Yes (current default) | Stage 6 |
| 5 | May import **service** invoices (foreign freight / insurance) be in FC? | Yes, only when linked to a shipment and an import category | Stage 3 |
| 6 | Revaluation frequency | Every period close | Stage 4 |
| 7 | Tax treatment of import VAT / duty / levies for fertilizer | Use the product / charge tax codes; confirm which are recoverable | Stage 3 |
| 8 | Enforce different users for dispatch and receipt? | Yes, Owner override logged | Stage 6 |
| 9 | Rebagging normal loss tolerance | e.g. ≤ 0.2 % absorbed; above → 6300 with approval | Stage 5 |
| 10 | Who may finalize / adjust costs after finalization | Accountant finalizes; Director approves post-finalization deltas | Stage 3 |
| 11 | Commercial view: how to spread storage (per kg-month?) | Per kg-month by days held | Stage 7 |

**Test fixtures** (built in the PGlite harness, all checks rolled back):

- **F1** — propagation example above (bulk + rebag + transfer + sales), Σ = D
  exactly, per-branch averages as expected.
- **F2** — CIF shipment USD 420,000 for 1,000 MT; title at 2,500 TZS/USD;
  invoice at 2,520 (AP stays at title TZS); payment debits TZS 1,066,800,000
  at 2,540 → realised FX loss 16,800,000; freight category rejected because
  CIF includes freight.
- **F3** — partial receipts 600 MT + 399 MT with 1 MT shortage resolved as
  normal loss; GR/IR and 1157 clear to zero.
- **F4** — rebag 400 MT into 6,000 × 50 kg, 3,000 × 25 kg, 4,000 × 5 kg
  (395 MT) with 1 MT normal loss and 4 MT unused bulk; packaging bags costed
  only to their own size; kg conserved.
- **F5** — transfer with charges, two partial receipts, signed POD, shortage
  claim; 1155 returns to zero; sender and receiver both see it; a third
  branch user cannot; dispatcher cannot receive.
- **F6** — concurrency / idempotency: the same receipt submitted twice with
  one key posts once; two receipts racing on one transfer never exceed
  dispatched quantity; late cost and a sale racing on one product serialise.
- **F7** — closed period: delta for a sale in a closed month posts in the open
  month; nothing dated in the closed month changes.
- **F8** — reversal dependencies: GRN void rejected after rebagging consumed
  its lot, with the dependent documents listed.
- **Regression**: existing Phase 2/3/4 suites and the D1/D2 reproductions
  (stock subledger = GL 1150 after voids and while goods are in transit).

### Stage 1 checks actually run

| Check | Result |
| --- | --- |
| Code reading of the files listed in §1.2 | done |
| D1 reproduction on a throwaway PGlite DB (`post_purchase` ×2, `void_purchase`) | difference −500 confirmed |
| D2 reproduction (`dispatch_stock_transfer`) | −600 in transit confirmed |
| D4 observation (two receipts with fresh keys) | both accepted |
| Production database | not touched; no migration created or applied in Stage 1 |

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
