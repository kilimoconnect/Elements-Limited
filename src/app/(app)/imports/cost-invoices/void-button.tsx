"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { voidCostInvoice } from "@/lib/costs/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function VoidCostInvoiceButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Reverse</Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} destructive requireReason confirmLabel="Reverse invoice"
        title={`Reverse cost invoice ${label}?`}
        description="Only while it is unpaid and has no credit notes. The payable and VAT are reversed today, the accrual it replaced comes back, and the cost difference it made is taken out of the goods wherever they are. The invoice and its journal stay on record."
        onConfirm={async (reason) => {
          const res = await voidCostInvoice(id, reason);
          if (!res.ok) return res.error ?? "Failed.";
          toast.success("Cost invoice reversed."); router.refresh();
        }} />
    </>
  );
}
