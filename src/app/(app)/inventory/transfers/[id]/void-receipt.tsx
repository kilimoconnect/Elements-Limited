"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import { voidTransferReceipt } from "@/lib/transfers/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** Admin: void a receipt recorded by mistake at the receiving branch. */
export function VoidReceiptButton({ id, number }: { id: string; number: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(() => crypto.randomUUID());
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => { setKey(crypto.randomUUID()); setOpen(true); }}>
        <Undo2 className="h-3.5 w-3.5" /> Void receipt
      </Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} destructive requireReason confirmLabel={`Void ${number}`}
        title={`Void receipt ${number}?`}
        description="The goods accepted into stock leave this branch at the value they came in with and go back into transit, and the received, damaged and short quantities are undone, so the truck can be received again. Not possible when its damaged or short cargo was already decided, or when the goods were already sold or moved. This cannot be undone."
        onConfirm={async (reason) => {
          const r = await voidTransferReceipt(id, reason, key);
          if (!r.ok) return r.error;
          toast.success(`${number} voided. The truck is in transit again.`);
          router.refresh();
        }} />
    </>
  );
}
