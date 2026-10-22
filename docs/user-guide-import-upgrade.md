# User guide — imports, rebagging, transfers and costing

For Owners, accountants, purchasing, storekeepers and branch staff. Each
section names the menu, the main buttons and who may use them. You only see
menus that are switched on (Admin → Feature Flags) and that your role allows.
Amounts are in TZS unless a document is in a foreign currency. Dates are
DD/MM/YYYY.

**Golden rule:** each supplier invoice or cost is entered **once**, in one
place:

| What it is | Where to enter it |
| --- | --- |
| Goods invoice for an import shipment | Importation → shipment → **Goods invoice** |
| Freight, insurance, duty, clearing, transport, storage, rebagging labour, transfer charges | Importation → **Cost Invoices** (linked to the shipment, rebagging order, transfer trip or purchase) |
| Ordinary local purchase of goods | Purchases → Create Purchase |
| Running costs not tied to goods (rent, salaries, utilities) | Expenses |

The system rejects a cost source that is already invoiced elsewhere. Do not
post the same invoice as an Expense "to be safe".

---

## 1. Set-up (Owner, once)

1. **Admin → Feature Flags**: switch on what you will use (`imports`,
   `rebagging`, `transfer_logistics`, `attachments`, `fx_settlement`).
2. **Admin → Exchange Rates**: rates for each foreign currency you buy in,
   with the date and source.
3. **Admin → Cost Categories**: for each cost type, set whether it is
   capitalised into stock or expensed, its account, and how it is allocated
   (net kg, value, quantity or manual).
4. **Admin → Account Mappings**: check the posting accounts with the
   accountant. They are pre-filled with 1155, 1157, 2130, 2140, 1145, 1170,
   1175, 4400/4410 and 6400/6410.
5. **Admin → Products**:
   - Bulk products use the kg unit and stock role *Bulk*.
   - Bag products use stock role *Packaged*, with their **Net kg per unit**
     (50 / 25 / 5) and the bulk product they are filled from.
   - Set the **Rebagging loss tolerance %** (bulk products) and the
     **Transfer loss tolerance %**. Both default to 0, which means every loss
     needs a decision.
6. **Admin → Roles & Permissions**: decide who approves abnormal rebagging loss
   (`rebagging.approve`), who resolves transfer discrepancies
   (`inventory.transfer_resolve`), who records transfer costs
   (`inventory.transfer_cost`) and who may see drivers' licence numbers
   (`documents.view_licence`).

---

## 2. Foreign-currency purchases (purchasing, accountant)

- **Purchases → Create Purchase**: choose a foreign supplier, the currency and
  the rate. Prices are entered in the foreign currency, and the system stores
  the TZS value at that rate.
- **Supplier Payments**: enter the foreign amount settled **and** the TZS
  actually paid from the bank. The difference posts as realised FX, and bank
  charges can be entered separately.
- Advances paid before the invoice are applied later at their original TZS
  value.
- Returns and credit notes beyond the open balance become **Supplier Credits**
  (Purchases → Supplier Credits). Use them on a later invoice, or **Record
  refund** when the supplier pays back.
- **Accounting → FX Revaluation** (month end, `fx.revalue`): enter the closing
  rate per currency, and open balances are restated. Revalue in date order.
  Later payments cannot be dated before a revaluation.

## 3. Import shipments (purchasing, accountant)

1. **Importation → New Shipment**: supplier, incoterm, whether the price
   includes freight and insurance, expected arrival, lines (product, kg,
   price).
2. **Mark shipped**, then **Record ownership** on the date title passes. From
   then the goods count as import goods in transit (1157).
3. **Goods invoice**: post the supplier's invoice once. It goes through
   Purchases as an invoice-only document.
4. **Costs** (Add cost) in three steps:
   - **Estimate**: plan freight, duty, clearing and so on.
   - **Accrue** or **Post accrual**: book the expected cost (2140) when the
     service is received but not yet invoiced.
   - **Cost invoice**: post the actual invoice from the forwarder or TRA. The
     accrual is released, and any difference is a variance.
5. **Receive goods** (branch storekeeper): record the kg received per line,
   partially if needed. Shortage, damage and excess are recorded and resolved.
   Stock enters at landed cost per kg.
6. **Finalise landed cost** when all costs are in. Costs that arrive later are
   still allowed: see §7.

## 4. Rebagging (storekeeper, approver)

**Inventory → Rebagging → New rebagging order**:
- **Add batch**: the bulk product and kg to issue (from the branch's stock).
- **Add size**: the bag products and the number of bags planned. One order can
  produce several sizes, and bulk can be left unused.
- **Add material**: empty bags, thread and labels taken from stock.
- **Add charge**: labour or other costs. Enter the invoice under Cost Invoices
  and link it to the order.

Steps:
1. **Issue bulk**: the kg leave bulk stock into rebagging work in progress.
2. **Complete**: enter the bags actually produced and any bulk returned.
   - Loss within the product's tolerance is *normal* and is absorbed into the
     bag cost.
   - Loss above the tolerance is *abnormal*. It needs `rebagging.approve` and
     a reason, and is expensed.
3. **Cancel order** before completion returns the bulk.
4. **Void** a completed order only while its bags are still unused.

Bag cost = (bulk cost + materials + charges − abnormal loss), shared by net kg.

## 5. Branch transfers (sending branch, receiving branch)

**Inventory → Stock Transfers / In Transit** lists open transfers for your
branches, overdue arrivals and document counts.

**Sending: Inventory → Stock Transfers → New Transfer** is one page:
- **Route:** from branch, to branch, dispatch date and expected arrival.
- **Goods:** the products and quantities.
- **Truck and driver:**
  - truck and trailer registration;
  - driver name, phone and driving licence number (the licence is visible
    only to users with `documents.view_licence`);
  - transporter company and contact.
- **Transfer costs:** loading, transport and any other fees (*Other transfer
  charges*), each with an amount in TZS. Every charge offered here goes into
  the inventory cost of the goods at the receiving branch, shared by weight.

Then choose:
- **Save draft** to keep it for later.
- **Save & Dispatch** to send it now. The stock moves to in transit (1155) at
  the sending branch's average cost, and the costs are booked onto the goods.
  A user without transfer-cost rights can dispatch, but the costs then wait
  for an approver.

**On the transfer page:**
- **Delivery note (PDF)** issues the numbered, versioned delivery note. If the
  driver or vehicle changes (**Change driver / vehicle**), issue a new version.
- Add documents (licence photo, loading photos, weighbridge ticket, signed
  delivery note).
- **Post update** records progress both branches see.
- More trucks for the same transfer: **New dispatch trip**.

**Receiving: Record arrival / receive** (receiving branch):
- Enter the accepted, damaged / quarantined and short quantities, the arrival
  time and who signed.
- **Offloading and other arrival charges:** enter what this branch paid on
  arrival. Those charges are added to the cost of the goods received at this
  branch.

**Resolve** each discrepancy:
- **Release into stock**
- **Arrived late (into stock)**
- **Normal loss (within tolerance)**: the cost is absorbed by the goods
  received.
- **Write off (expense)**: posts to 6300.
- **Claim (carrier / insurer)**: posts to 1145.

**Each branch's inventory cost** is its own weighted average: what the goods
cost at the sending branch, plus that transfer's loading, transport,
offloading and other charges. **Void trip** is allowed only before anything is
received.

## 6. Costs on ordinary purchases (accountant)

On a posted purchase (Purchases → history → the purchase):
- **Add landed cost**: a transport or other cost on a local purchase. Enter it
  as a cost source, then accrue or invoice it.
- Supplier price notes are **Credit note** or **Debit note**. They correct
  the price of goods already received, and the effect follows the goods (§7).

## 7. Late costs and corrections

When an invoice, credit note or variance arrives after the goods have moved,
the system follows the goods automatically:
- to stock still held, at whichever branch it now sits;
- to goods still in transit;
- to bags made from the bulk;
- to **cost of sales** for units already sold.

Each share is listed in **Reports → Late Cost Adjustments**. If the original
period is closed, the adjustment posts in the current open period and is
marked as a catch-up.

Corrections never delete anything. Use these instead, each of which posts a
linked, dated reversal:
- **Reverse** or **Void** on a cost invoice, while it is unpaid;
- **Void** on a goods invoice, while it is unpaid;
- credit and debit notes;
- **Void** on a rebagging order or trip.

## 8. Pricing (Inventory → Pricing)

- Choose a branch and a product. The page shows that branch's **inventory
  cost**: its weighted-average cost, which already includes the import,
  rebagging and transfer costs of bringing the goods there. A table shows the
  cost and margin at every branch.
- Choose **margin** or **markup** and enter the %. The price before VAT and
  the price including VAT (from the product's tax code) are both shown.
- Only the Owner can **Save as approved selling price**. The old and new price
  and the reason are kept. Stock values do not change. The approved price
  applies to all branches; the table shows the margin it gives at each one.

## 9. Reports for control

| Report | Use it to |
| --- | --- |
| Cost Reconciliation | 13 checks tying stock, in-transit, GR/IR, accruals and payables to the GL. Every check should show OK. Run it daily at first and before every period close. |
| Costing Exceptions | Overdue arrivals, open discrepancies, accruals older than 30 days, unallocated charges |
| Shipment Costing | Estimated vs actual cost per kg / MT per shipment |
| Rebagging Costing | Yield, normal and abnormal loss, cost per bag |
| Transfer Costing | Charges per trip and per unit; losses and claims |
| Branch Landed Cost | Each branch's inventory cost per unit, per kg and per bag size |
| Profitability | Margin by product, branch and customer, and which shipment the sold goods came from |
| Late Cost Adjustments | Where each late cost went (stock, transit, cost of sales; catch-ups) |

## 10. Month end (accountant)

1. Post all known cost invoices. Accrue services received but not invoiced.
2. Run FX Revaluation for open foreign balances.
3. In Cost Reconciliation, check that all items are OK. Explain open 2140
   (accruals) and 2130 (goods received, not invoiced). Check that 1155 equals
   the open trips.
4. **Accounting → Period Close**.
