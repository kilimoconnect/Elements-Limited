# Release notes — import, rebagging & transfer upgrade

Branch `release/import-upgrade` · migrations `0024`–`0033` · prepared 22/10/2026.
Status: **release candidate, not deployed.** See
`docs/deployment-runbook-import-upgrade.md` for the deployment steps and what
must happen first (credential rotation, staging walkthrough).

All amounts are recorded in TZS. Foreign currency appears only on
purchase-origin documents. Dates are DD/MM/YYYY and the time zone is
Africa/Dar_es_Salaam. Each new workflow sits behind a feature flag
(Admin → Feature Flags), and every flag is OFF after migration.

## New

**Foreign-currency purchases** (`fx_settlement`)
- Purchase invoices in USD and other currencies at a dated exchange rate. The
  books stay in TZS.
- Payments record both the foreign amount settled and the TZS actually paid.
  The difference posts as realised FX gain or loss (4400 / 6400), and bank
  charges post separately.
- Supplier advances (1175) and supplier credits (1170), including refunds of
  credits.
- Period-end revaluation of open foreign balances (4410 / 6410). It restates
  the carrying amount, so a later payment measures realised FX from the
  revalued figure. There is no automatic reversal and nothing is counted
  twice.

**Import shipments and landed cost** (`imports`)
- A shipment records the incoterm, its lines and a title event.
- The goods invoice is posted once through Purchases (invoice-only). Receipts
  clear GR/IR (2130), so the same invoice cannot also be posted through
  Expenses or Importation.
- Acquisition costs (freight, insurance, duty, clearing, transport) move from
  estimate to accrual (2140) to actual, through cost invoices. They are
  allocated by kg, value, quantity or by hand, with exact rounding so the
  totals reconcile.
- Goods receipts (GRN) support partial receipts. Shortages, damage and excess
  are resolved explicitly.

**Bulk-to-bag rebagging** (`rebagging`)
- One order can produce several bag sizes and leave bulk unused.
- Packaging materials are charged to the order, and labour or other charges
  can be added.
- Normal loss (within each product's tolerance) is absorbed into the bags.
  Abnormal loss needs `rebagging.approve` and is expensed.
- An order can be cancelled or voided while its bags are unused.

**Branch transfers** (`transfer_logistics`)
- Each trip records the driver, vehicle, transporter, agents and charges
  (loading, transport, offloading, other).
- Stock in transit is held in 1155 and is visible to both the sending and the
  receiving branch.
- Delivery notes are versioned PDFs with a printable snapshot. Licence numbers
  appear only for users with `documents.view_licence`.
- Partial receipts support signed proof of delivery. Shortages are resolved as
  found, normal loss, write-off (6300) or claim (1145).
- Legacy transfers that were open before the upgrade keep their original
  behaviour.

**Documents** (`attachments`)
- Files sit in a private Storage bucket and are reached only through
  short-lived signed links, after checks on branch and category permission.

**Late costs and corrections**
- A cost that arrives after the goods have moved follows the goods through
  receipts, rebagging, transfers and sales. It goes to stock still held, to
  stock in transit and to cost of sales, in proportion. Every share is
  recorded.
- Supplier price notes (`purchase_cost_adjustments`) cover ordinary purchases.
- If the period is closed, the adjustment posts in the open period and is
  flagged as a catch-up.
- Reversals are dated and linked to their originals:
  - goods invoice void;
  - cost invoice void;
  - rebag cancel and void;
  - trip void.

**Pricing** (Inventory → Pricing)
- Accounting cost and commercial overhead give the pricing cost.
- Prices can be suggested by markup or by margin, with VAT taken from the
  product's tax code.
- Only the Owner can change a price, and every change is kept in
  `product_price_changes`.

**Reports**
- Shipment Costing, Rebagging Costing, Transfer Costing, Branch Landed Cost,
  Profitability (with the shipment → sale trace), Costing Exceptions, Late
  Cost Adjustments.
- Cost Reconciliation runs 13 automated checks that tie the subledgers to
  1150, 1155, 2130, 2140 and 2110.

**Admin**
- New screens: Feature Flags, Account Mappings, Cost Categories, Exchange
  Rates.
- Product fields: stock role (bulk / packaged / standard), net kg per unit,
  bulk source, and rebagging and transfer loss tolerance %.

## Changed

- Inventory valuation now includes rebagging work in progress and legacy
  stock in transit.
- Payables ageing now includes cost-invoice payables and price notes.
- New permissions: `imports.*`, `cost_invoices.*`, `rebagging.*`,
  `inventory.transfer_cost`, `documents.view_licence`, `fx.revalue`. They are
  granted by `npm run db:seed` according to `src/lib/auth/permissions.ts`.
- Branch users see transfers only for their own branches; this is enforced in
  the database.

## Hardening in this release (migration 0033)

- Indexes for cost replay, journals by source, and trip, receipt, rebagging,
  lot and document lookups at realistic volumes.
- Trigger functions can no longer be called directly through the API.
- **Fixed:** older transaction tables (sales, purchases, returns, expenses,
  payments, adjustments, openings, other income, journals and their lines)
  now reject references to another company's customer, supplier, product,
  account or branch. Previously a crafted request could link them.
- Delivery notes now print the dispatch date in DD/MM/YYYY.
- A purchase draft now rejects a supplier from another company.

## Known limitations

- **No signed-in browser walkthrough yet.** The new screens were exercised
  through the database tests and an unauthenticated route check, not by
  clicking through them signed in, because there is no staging Supabase
  project. This must be done on staging before go-live.
- **Concurrency is not tested.** Row locks, idempotency keys and lock order
  are in place, but the test database is single-connection, so two
  simultaneous postings were never run.
- `npm run lint` fails with 11 errors, all of them in Phase 1–4 files that
  this upgrade did not change (React-compiler rules, `prefer-const`,
  `no-explicit-any`). Typecheck, the unit tests, all database suites and the
  build pass.
- Some items found in Stage 1 are still open: D1 and D5, and caller-supplied
  idempotency keys outside transfers (see `docs/letiq-import-upgrade.md`).
- Out of scope: payroll, budgets, purchase orders, live bank feeds, TRA/EFD
  filing, consolidation.
