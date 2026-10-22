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
| 2b | Remaining hardening from Stage 1: fix void/transfer subledger drift (D1, D2, D5), goods-in-transit 1155 on transfers, branch enforcement in the existing transfer actions (D3), caller-supplied idempotency keys in existing server actions (D4), lot maintenance with an "untracked" lot for existing stock | Not started — recommended before Stage 3 posts anything |
| 3 | Foreign purchases with TZS books: foreign purchase invoices, foreign supplier balances (original currency + TZS carrying), settlements through TZS accounts with realised FX, advances, bank charges, period-end revaluation, foreign returns and credits, currency confinement | **Done 21/10/2026** (record below) |
| 4 | Import shipments: shipment + lines, title (ownership) event, goods invoice via `purchases` invoice-only mode, GR/IR clearing, cost sources (estimate → accrual → actual) and `cost_invoices`, allocations, goods receipt (GRN) with discrepancy resolution, late-cost propagation for import lots | **Done 21/10/2026** (record below; screens not yet walked through in a browser) |
| 5 | Rebagging orders (multi-size outputs, packaging materials, normal/abnormal loss, unused bulk) + propagation through conversion | **Done 22/10/2026** (record below; screens not yet run in a browser) |
| 6 | Transfer upgrade: logistics details, charges, Storage attachments, versioned delivery notes, partial receipts with signed POD, discrepancy approval, shared in-transit view + propagation through transfers | Not started |
| 7 | Commercial (pricing) cost view and import / landed-cost reports | Not started |

Each stage extends the existing posting services (`record_stock_movement`,
`create_journal`, `claim_idempotency`, `assert_period_open`, supplier
payables, transfers) rather than adding a parallel ERP.

---

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
