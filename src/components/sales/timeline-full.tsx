"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type TimelineRow = { id: string; title: string; truck: string | null; note: string | null; meta: string };

export function TimelineList({ rows }: { rows: TimelineRow[] }) {
  return (
    <ol className="space-y-3 border-l border-border pl-4">
      {rows.map((e) => (
        <li key={e.id} className="relative text-sm">
          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
          <p className="font-medium">{e.title}{e.truck ? <span className="font-normal text-muted-foreground"> · {e.truck}</span> : null}</p>
          {e.note && <p className="text-muted-foreground">{e.note}</p>}
          <p className="text-xs text-muted-foreground">{e.meta}</p>
        </li>
      ))}
    </ol>
  );
}

/** The whole history in its own window, so long timelines do not stretch the page. */
export function FullTimelineButton({ rows }: { rows: TimelineRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>View full timeline ({rows.length})</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Timeline</DialogTitle>
            <DialogDescription>Every step, oldest first.</DialogDescription>
          </DialogHeader>
          <TimelineList rows={rows} />
        </DialogContent>
      </Dialog>
    </>
  );
}
