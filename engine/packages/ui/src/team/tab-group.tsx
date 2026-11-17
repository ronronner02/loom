import type { ReactNode } from "react";

/**
 * A set of toggle buttons that pick one of N views. `aria-pressed` per button, one pressed at a
 * time, is the contract every tab strip in the product already used; this is that contract.
 */
export function TabGroup<T extends string>({ label, items, value, onChange, className = "ui-subtabs" }: {
  label: string; items: ReadonlyArray<{ id: T; label: ReactNode; disabled?: boolean }>;
  value: T; onChange: (id: T) => void; className?: string;
}) {
  return <div className={className} role="group" aria-label={label}>
    {items.map(item => <button key={item.id} type="button" disabled={item.disabled}
      aria-pressed={item.id === value} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>;
}