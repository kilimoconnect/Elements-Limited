import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  ShoppingCart,
  Boxes,
  Truck,
  Coins,
  Receipt,
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Settings,
  Ship,
} from "lucide-react";

export interface NavLeaf {
  label: string;
  href: string;
  enabled: boolean;
  /** Permission required to see it (Owner always sees enabled items). */
  requires?: string;
  /** Feature flag that must be on for the company (applies to the Owner too). */
  feature?: string;
}

export interface NavEntry {
  label: string;
  icon: LucideIcon;
  /** A direct link (leaf) ... */
  href?: string;
  enabled: boolean;
  ownerOnly?: boolean;
  requires?: string;
  feature?: string;
  /** ...or a group of children. */
  items?: NavLeaf[];
}

export const NAV: NavEntry[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/dashboard", enabled: true },
  {
    label: "Sales",
    icon: ShoppingCart,
    enabled: true,
    requires: "sales.view",
    items: [
      { label: "Create Sale", href: "/sales/new", enabled: true, requires: "sales.create" },
      { label: "Sales History", href: "/sales/history", enabled: true, requires: "sales.view" },
      { label: "Customer Payments", href: "/sales/customer-payments", enabled: true, requires: "sales.view" },
    ],
  },
  {
    label: "Inventory",
    icon: Boxes,
    enabled: true,
    requires: "inventory.view",
    items: [
      { label: "Current Stock", href: "/inventory", enabled: true, requires: "inventory.view" },
      { label: "Kardex", href: "/inventory/kardex", enabled: true, requires: "inventory.view_kardex" },
      { label: "Stock Transfers / In Transit", href: "/inventory/transfers", enabled: true, requires: "inventory.transfer_view" },
      { label: "Stock Adjustments", href: "/inventory/adjustments", enabled: true, requires: "inventory.adjustment_create" },
      { label: "Rebagging", href: "/inventory/rebagging", enabled: true, requires: "rebagging.view", feature: "rebagging" },
      { label: "Pricing", href: "/inventory/pricing", enabled: true, requires: "inventory.view_cost" },
      { label: "Opening Balances", href: "/inventory/opening-balances", enabled: true, requires: "inventory.opening_balance" },
    ],
  },
  {
    label: "Purchases",
    icon: Truck,
    enabled: true,
    requires: "purchases.view",
    items: [
      { label: "Create Purchase", href: "/purchases/new", enabled: true, requires: "purchases.create" },
      { label: "Purchase History", href: "/purchases/history", enabled: true, requires: "purchases.view" },
      { label: "Supplier Credits", href: "/purchases/supplier-credits", enabled: true, requires: "purchases.view" },
      { label: "Supplier Payments", href: "/purchases/supplier-payments", enabled: true, requires: "purchases.record_payment" },
    ],
  },
  {
    label: "Importation",
    icon: Ship,
    enabled: true,
    requires: "imports.view",
    feature: "imports",
    items: [
      { label: "Shipments", href: "/imports", enabled: true, requires: "imports.view", feature: "imports" },
      { label: "New Shipment", href: "/imports/new", enabled: true, requires: "imports.create", feature: "imports" },
      { label: "Cost Invoices", href: "/imports/cost-invoices", enabled: true, requires: "cost_invoices.view", feature: "imports" },
    ],
  },
  {
    label: "Expenses",
    icon: Receipt,
    enabled: true,
    requires: "expenses.view",
    items: [
      { label: "Record Expense", href: "/expenses/new", enabled: true, requires: "expenses.create" },
      { label: "Expense History", href: "/expenses/history", enabled: true, requires: "expenses.view" },
    ],
  },
  {
    label: "Other Income",
    icon: Coins,
    enabled: true,
    requires: "other_income.view",
    items: [
      { label: "Record Income", href: "/other-income/new", enabled: true, requires: "other_income.create" },
      { label: "Income History", href: "/other-income/history", enabled: true, requires: "other_income.view" },
    ],
  },
  {
    label: "Cash and Banks",
    icon: ArrowLeftRight,
    enabled: true,
    requires: "cash_accounts.view",
    items: [
      { label: "Accounts", href: "/cash-and-banks", enabled: true, requires: "cash_accounts.view" },
      { label: "Cash Transfer", href: "/cash-and-banks/transfer", enabled: true, requires: "cash_transfers.create" },
      { label: "Transfers", href: "/cash-and-banks/transfers", enabled: true, requires: "cash_transfers.view" },
      { label: "Reconciliation", href: "/cash-and-banks/reconciliation", enabled: true, requires: "reconciliation.view" },
      { label: "Opening Balances", href: "/cash-and-banks/opening-balances", enabled: true, requires: "cash_accounts.opening_balance" },
    ],
  },
  {
    label: "Accounting",
    icon: BookOpen,
    enabled: true,
    requires: "accounting.view",
    items: [
      { label: "Overview", href: "/accounting", enabled: true, requires: "accounting.view" },
      { label: "Journals", href: "/accounting/journals", enabled: true, requires: "accounting.view_journals" },
      { label: "Manual Journal", href: "/accounting/journals/new", enabled: true, requires: "accounting.create_manual_journal" },
      { label: "General Ledger", href: "/accounting/general-ledger", enabled: true, requires: "accounting.view_general_ledger" },
      { label: "Trial Balance", href: "/accounting/trial-balance", enabled: true, requires: "accounting.view_trial_balance" },
      { label: "Opening Balances", href: "/accounting/opening-balances", enabled: true, requires: "accounting.manage_opening_balances" },
      { label: "Reconciliation Controls", href: "/accounting/reconciliation-controls", enabled: true, requires: "accounting.view_control_accounts" },
      { label: "FX Revaluation", href: "/accounting/fx-revaluation", enabled: true, requires: "fx.revalue", feature: "fx_settlement" },
      { label: "Period Close", href: "/accounting/period-close", enabled: true, requires: "periods.view" },
    ],
  },
  {
    label: "Reports",
    icon: BarChart3,
    enabled: true,
    requires: "reports.view",
    items: [
      { label: "Profit & Loss", href: "/reports/profit-and-loss", enabled: true, requires: "reports.view_profit_loss" },
      { label: "Balance Sheet", href: "/reports/balance-sheet", enabled: true, requires: "reports.view_balance_sheet" },
      { label: "Cash Flow", href: "/reports/cash-flow", enabled: true, requires: "reports.view_cash_flow" },
      { label: "VAT Report", href: "/reports/vat", enabled: true, requires: "reports.view_vat" },
      { label: "Receivables Ageing", href: "/reports/receivables-ageing", enabled: true, requires: "reports.view_receivables" },
      { label: "Payables Ageing", href: "/reports/payables-ageing", enabled: true, requires: "reports.view_payables" },
      { label: "Customer Statements", href: "/reports/customer-statements", enabled: true, requires: "reports.view_receivables" },
      { label: "Supplier Statements", href: "/reports/supplier-statements", enabled: true, requires: "reports.view_payables" },
      { label: "Inventory Valuation", href: "/reports/inventory-valuation", enabled: true, requires: "reports.view_inventory_valuation" },
      { label: "Late Cost Adjustments", href: "/reports/late-costs", enabled: true, requires: "reports.view_inventory_valuation" },
      { label: "Cost Reconciliation", href: "/reports/cost-reconciliation", enabled: true, requires: "reports.view_inventory_valuation" },
      { label: "Shipment Costing", href: "/reports/shipment-costing", enabled: true, requires: "imports.view_cost", feature: "imports" },
      { label: "Rebagging Costing", href: "/reports/rebagging-costing", enabled: true, requires: "inventory.view_cost", feature: "rebagging" },
      { label: "Transfer Costing", href: "/reports/transfer-costing", enabled: true, requires: "inventory.view_cost" },
      { label: "Branch Landed Cost", href: "/reports/branch-landed-cost", enabled: true, requires: "inventory.view_cost" },
      { label: "Profitability", href: "/reports/profitability", enabled: true, requires: "reports.view_profit_loss" },
      { label: "Costing Exceptions", href: "/reports/exceptions", enabled: true, requires: "inventory.view_cost" },
    ],
  },
  { label: "Admin", icon: Settings, href: "/admin", enabled: true, ownerOnly: true },
];

/** Whether a user (with a permission set) may see a nav entry/leaf. */
export function canSee(
  entry: { requires?: string; ownerOnly?: boolean; feature?: string },
  isOwner: boolean,
  perms: Set<string>,
): boolean {
  if (entry.feature && !perms.has(`feature:${entry.feature}`)) return false;
  if (entry.ownerOnly) return isOwner;
  if (isOwner) return true;
  if (entry.requires) return perms.has(entry.requires);
  return true;
}
