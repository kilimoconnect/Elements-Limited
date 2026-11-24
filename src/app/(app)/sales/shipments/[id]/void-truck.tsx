"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import { voidShipment } from "@/lib/sales/fulfilment-actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** Admin: void a dispatched or collected truck. */
export function VoidTruckButton({ id, number, invoice, collection }: { id: string; number: string; invoice: string | null; collection: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(() => crypto.randomUUID());
  return (
    <>
      <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => { setKey(crypto.randomUUID()); setOpen(true); }}>
        <Ban className="h-4 w-4" /> Void {collection ? "collection" : "truck"}
      </Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} destructive requireReason confirmLabel={`Void ${number}`}
        title={`Void ${collection ? "the collection of" : "truck"} ${number}?`}
        description={`Invoice ${invoice ?? "-"} is voided, the goods go back into stock, and the customer's advance goes back to the sales order, which reopens so the goods can be loaded again. Payments on the invoice other than the order's advance, and returns, must be voided first. This cannot be undone.`}
        onConfirm={async (reason) => {
          const r = await voidShipment(id, reason, key);
          if (!r.ok) return r.error;
          toast.success(`${number} voided. The order is open again.`);
          router.refresh();
        }} />
    </>
  );
}
