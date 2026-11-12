import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
