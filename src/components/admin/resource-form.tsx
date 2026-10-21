"use client";

import * as React from "react";
import { toast } from "sonner";
import { saveResource } from "@/lib/admin/actions";
import { AUTO_CODE_PREFIXES, type FieldDef, type ResourceConfig } from "@/lib/admin/resources";
import type { OptionMap } from "@/lib/admin/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const NONE = "__none__";

type Values = Record<string, unknown>;

function initialValues(config: ResourceConfig, row: Values | null): Values {
  const v: Values = {};
  for (const f of config.fields) {
    if (row && row[f.name] !== undefined && row[f.name] !== null) {
      v[f.name] = row[f.name];
    } else if (row && row[f.name] === null) {
      v[f.name] = f.type === "switch" ? false : "";
    } else {
      v[f.name] = f.defaultValue ?? (f.type === "switch" ? false : "");
    }
  }
  return v;
}

export function ResourceForm({
  config,
  options,
  row,
  onCancel,
  onSaved,
}: {
  config: ResourceConfig;
  options: OptionMap;
  row: Values | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = React.useState<Values>(() =>
    initialValues(config, row),
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const id = (row?.id as string | undefined) ?? null;

  function setField(name: string, value: unknown) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});
    const res = await saveResource(config.key, id, values);
    if (res.ok) {
      toast.success(`${config.singular} ${id ? "updated" : "created"}.`);
      onSaved();
    } else {
      setError(res.error ?? "Could not save.");
      if (res.fieldErrors) setFieldErrors(res.fieldErrors);
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {config.fields.map((f) => {
          const autoPrefix = AUTO_CODE_PREFIXES[config.key];
          const isCode = autoPrefix && f.name === config.codeField;
          const field: FieldDef = isCode
            ? {
                ...f,
                required: false,
                placeholder: id ? f.placeholder : `Auto-generated (e.g. ${autoPrefix}-0001) — or type your own`,
                help: id ? "Code cannot be changed after creation." : "Leave blank to auto-generate.",
              }
            : f;
          return (
            <FieldControl
              key={f.name}
              field={field}
              value={values[f.name]}
              options={f.optionsKey ? options[f.optionsKey] ?? [] : []}
              error={fieldErrors[f.name]}
              disabled={pending || Boolean(isCode && id)}
              onChange={(v) => setField(f.name, v)}
            />
          );
        })}
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : id ? "Save changes" : `Create ${config.singular}`}
        </Button>
      </div>
    </form>
  );
}

function FieldControl({
  field,
  value,
  options,
  error,
  disabled,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  options: { value: string; label: string }[];
  error?: string;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const spanClass = field.colSpan === 2 ? "sm:col-span-2" : "";
  const id = `field-${field.name}`;

  if (field.type === "switch") {
    return (
      <div className={cn("flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2", spanClass)}>
        <div>
          <Label htmlFor={id}>{field.label}</Label>
          {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
        </div>
        <Switch
          id={id}
          checked={Boolean(value)}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", spanClass)}>
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>

      {field.type === "textarea" ? (
        <Textarea
          id={id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      ) : field.type === "select" ? (
        <Select
          value={(value as string) ? (value as string) : field.nullable ? NONE : undefined}
          onValueChange={(v) => onChange(v === NONE ? "" : v)}
          disabled={disabled}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {field.nullable && <SelectItem value={NONE}>— None —</SelectItem>}
            {(field.options ?? options).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={
            field.type === "date"
              ? "date"
              : field.type === "number" || field.type === "money" || field.type === "quantity"
                ? "number"
                : "text"
          }
          step={field.step ?? (field.type === "money" ? "0.01" : field.type === "quantity" ? "0.0001" : undefined)}
          min={field.min}
          max={field.max}
          value={(value as string | number) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )}

      {field.help && (
        <p className="text-xs text-muted-foreground">{field.help}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
