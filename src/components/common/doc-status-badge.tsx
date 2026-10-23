import { Badge } from "@/components/ui/badge";

const DOC: Record<string, { label: string; variant: "default" | "success" | "muted" | "destructive" | "warning" | "secondary" }> = {
  draft: { label: "Draft", variant: "muted" },
  pending_approval: { label: "Awaiting approval", variant: "warning" },
  rejected: { label: "Rejected", variant: "destructive" },
  posted: { label: "Posted", variant: "success" },
  voided: { label: "Voided", variant: "destructive" },
  dispatched: { label: "Dispatched", variant: "default" },
  partially_received: { label: "Partial", variant: "warning" },
  received: { label: "Received", variant: "success" },
};

const PAY: Record<string, { label: string; variant: "default" | "success" | "muted" | "destructive" | "warning" | "secondary" }> = {
  unpaid: { label: "Unpaid", variant: "destructive" },
  partially_paid: { label: "Partial", variant: "warning" },
  paid: { label: "Paid", variant: "success" },
  refunded: { label: "Refunded", variant: "muted" },
  partially_refunded: { label: "Part. refunded", variant: "warning" },
};

/** A sale's status as people see it: a draft shows its approval state. */
export function saleStatus(documentStatus: string, approvalStatus: string | null | undefined): string {
  if (documentStatus !== "draft") return documentStatus;
  if (approvalStatus === "pending") return "pending_approval";
  if (approvalStatus === "rejected") return "rejected";
  return "draft";
}

export function DocStatusBadge({ status }: { status: string }) {
  const s = DOC[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function PayStatusBadge({ status }: { status: string }) {
  const s = PAY[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
