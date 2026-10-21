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
| 2 | Hardening prerequisites: fix void/transfer subledger drift (D1, D2, D5), goods-in-transit 1155 on transfers, server/DB branch enforcement for transfers (D3), caller-supplied idempotency keys (D4), provenance lots + `stock_lot_flows` with an "untracked" lot for existing stock | Not started |
| 3 | Import shipments: shipment + lines, title (ownership) event, goods invoice via extended `purchases` (FC, rate snapshot, invoice-only mode), GR/IR clearing, cost sources (estimate → accrual → actual) and `cost_invoices`, allocations, goods receipt (GRN) with discrepancy resolution, late-cost propagation for import lots (held / sold / written off) | Not started |
| 4 | Foreign-currency settlement: supplier advances, FC payments (original currency settled + actual TZS debited), realised FX, period-end reversing revaluation, FC credits | Not started |
| 5 | Rebagging orders (multi-size outputs, packaging materials, normal/abnormal loss, unused bulk) + propagation through conversion | Not started |
| 6 | Transfer upgrade: logistics details, charges, Storage attachments, versioned delivery notes, partial receipts with signed POD, discrepancy approval, shared in-transit view + propagation through transfers | Not started |
| 7 | Commercial (pricing) cost view and import / landed-cost reports | Not started |

Each stage extends the existing posting services (`record_stock_movement`,
`create_journal`, `claim_idempotency`, `assert_period_open`, supplier
payables, transfers) rather than adding a parallel ERP.

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
