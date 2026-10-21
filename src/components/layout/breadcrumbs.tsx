"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";

const LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  admin: "Admin",
  account: "My Account",
  company: "Company",
  branches: "Branches",
  products: "Products",
  "product-categories": "Product Categories",
  categories: "Categories",
  brands: "Brands",
  units: "Units of Measurement",
  "tax-codes": "Tax Codes",
  "payment-accounts": "Payment Accounts",
  "other-income-types": "Other Income Types",
  "expense-categories": "Expense Categories",
  customers: "Customers",
  suppliers: "Suppliers",
  "chart-of-accounts": "Chart of Accounts",
  roles: "Roles & Permissions",
  users: "Users",
  "document-numbering": "Document Numbering",
  "accounting-periods": "Accounting Periods",
  "audit-log": "Audit Log",
  "cost-categories": "Cost Categories",
  "exchange-rates": "Exchange Rates",
};

function labelFor(segment: string) {
  return (
    LABELS[segment] ??
    segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      {segments.map((seg, i) => {
        const href = "/" + segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={href}>
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />}
            {isLast ? (
              <span className="font-medium text-foreground">{labelFor(seg)}</span>
            ) : (
              <Link
                href={href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {labelFor(seg)}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
