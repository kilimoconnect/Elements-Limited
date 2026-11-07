"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface PickedFile<C extends string> { key: string; file: File; category: C }

const MAX = 20 * 1024 * 1024;

/**
 * Pick any number of files, in one go or several; each is listed with its
 * size, a category and a remove button. Uploading is left to the caller.
 */
export function FilePickerList<C extends string>({ id, label, value, onChange, categories, required, hint }: {
  id: string; label: string; value: PickedFile<C>[]; onChange: (v: PickedFile<C>[]) => void;
  categories: { value: C; label: string }[]; required?: boolean; hint?: string;
}) {
  function add(list: FileList | null) {
    const picked = Array.from(list ?? []).filter((f) => !value.some((x) => x.file.name === f.name && x.file.size === f.size));
    onChange([...value, ...picked.map((file) => ({ key: Math.random().toString(36).slice(2), file, category: categories[0].value }))]);
  }
  return (
    <div className="space-y-1.5 rounded-md border border-dashed border-border p-3">
      <Label htmlFor={id}>{label} {required && <span className="text-destructive">*</span>}</Label>
      <Input id={id} type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      {value.length > 0 && (
        <ul className="space-y-1.5 pt-1">
          {value.map((f) => (
            <li key={f.key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`min-w-0 flex-1 truncate ${f.file.size > MAX ? "text-destructive" : ""}`}>
                {f.file.name} <span className="text-xs text-muted-foreground">({(f.file.size / 1024 / 1024).toFixed(1)} MB{f.file.size > MAX ? ", over 20 MB" : ""})</span>
              </span>
              {categories.length > 1 && (
                <Select value={f.category} onValueChange={(v) => onChange(value.map((x) => (x.key === f.key ? { ...x, category: v as C } : x)))}>
                  <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>{categories.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              )}
              <button type="button" aria-label={`Remove ${f.file.name}`} onClick={() => onChange(value.filter((x) => x.key !== f.key))} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{hint ?? "Choose several files at once or add more in several goes. PDF or photos, up to 20 MB each."}</p>
    </div>
  );
}

export const tooBig = (files: { file: File }[]) => files.find((f) => f.file.size > MAX);
