"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { normalisePhone } from "@/lib/phone";

/** A phone field that corrects the number when you leave it ("0687 322 677" -> "0687322677"). */
export function PhoneInput({ onBlur, onChange, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      inputMode="tel"
      {...props}
      onChange={onChange}
      onBlur={(e) => {
        const fixed = normalisePhone(e.currentTarget.value);
        if (fixed !== e.currentTarget.value) {
          e.currentTarget.value = fixed;
          onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
        }
        onBlur?.(e);
      }}
    />
  );
}
