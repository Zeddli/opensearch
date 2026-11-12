"use client";
// Shared AG Grid cell renderers.

import clsx from "clsx";
import { Check, ExternalLink, Star, X } from "lucide-react";
import type { CustomCellRendererProps } from "ag-grid-react";
import { Avatar } from "@/components/ui";

export function SellerCell(p: CustomCellRendererProps<{ seller: string; sellerRating?: number | null; kind?: string }>) {
  if (!p.data) return <span>{p.valueFormatted ?? p.value}</span>;
  return (
    <span className="flex h-full items-center gap-2">
      <Avatar name={p.data.seller} size={22} />
      <span className="min-w-0 truncate">{p.data.seller}</span>
      {p.data.sellerRating ? (
        <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-muted">
          <Star className="size-3 fill-current text-amber-500" />
          {p.data.sellerRating.toFixed(1)}
        </span>
      ) : null}
    </span>
  );
}

export function ProductCell(p: CustomCellRendererProps<{ product: string; url?: string | null }>) {
  if (!p.data) return null;
  return (
    <span className="flex h-full min-w-0 items-center gap-1.5">
      <span className="truncate" title={p.data.product}>
        {p.data.product}
      </span>
      {p.data.url && (
        <a href={p.data.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-muted hover:text-accent" onClick={(e) => e.stopPropagation()}>
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </span>
  );
}

export function DeadlineCell(p: CustomCellRendererProps) {
  if (p.value === null || p.value === undefined) return <span className="text-muted">—</span>;
  return p.value ? (
    <span className="inline-flex items-center gap-1 text-ok">
      <Check className="size-4" /> Yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-bad">
      <X className="size-4" /> No
    </span>
  );
}

export function ScoreBarCell(p: CustomCellRendererProps) {
  const v = typeof p.value === "number" ? p.value : null;
  if (v === null) return <span className="text-muted">—</span>;
  const color = v >= 75 ? "var(--color-ok)" : v >= 50 ? "var(--color-accent)" : v >= 30 ? "var(--color-warn)" : "var(--color-bad)";
  return (
    <span className="flex h-full items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(3, Math.min(100, v))}%`, background: color }} />
      </span>
      <span className="w-7 text-right text-xs font-medium tabular-nums">{Math.round(v)}</span>
    </span>
  );
}

function flagTone(f: string) {
  const s = f.toLowerCase();
  if (/(below market|suspicious|no return|risky|scam|too cheap|unverified|payment setup)/.test(s)) return "bad";
  if (/(late|over budget|deadline|missing|no warranty|partial)/.test(s)) return "warn";
  return "neutral";
}

export function FlagsCell(p: CustomCellRendererProps) {
  const flags: string[] = Array.isArray(p.value) ? p.value : [];
  if (!flags.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex h-full items-center gap-1 overflow-hidden" title={flags.join(" · ")}>
      {flags.map((f) => (
        <span
          key={f}
          className={clsx(
            "shrink-0 rounded-full px-1.5 py-px text-[11px] leading-4 font-medium",
            flagTone(f) === "bad" && "bg-bad-soft text-bad",
            flagTone(f) === "warn" && "bg-warn-soft text-warn",
            flagTone(f) === "neutral" && "bg-surface-2 text-fg-2",
          )}
        >
          {f}
        </span>
      ))}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-accent-soft text-accent",
  offered: "bg-accent-soft text-accent",
  countered: "bg-warn-soft text-warn",
  revised: "bg-ok-soft text-ok",
  won: "bg-ok-soft text-ok",
  paid: "bg-ok text-white",
  lost: "bg-surface-2 text-muted",
  withdrawn: "bg-surface-2 text-muted",
  listing: "bg-surface-2 text-fg-2",
};

export function StatusCell(p: CustomCellRendererProps) {
  if (!p.value) return null;
  const v = String(p.value);
  return <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATUS_TONE[v] ?? "bg-surface-2 text-fg-2")}>{v === "lost" ? "not selected" : v}</span>;
}

export function PriceCell(p: CustomCellRendererProps<{ prevUnitPrice?: number | null }>) {
  const prev = p.data?.prevUnitPrice;
  const dropped = typeof prev === "number" && typeof p.value === "number" && p.value < prev;
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      {dropped && <span className="text-[11px] text-muted line-through">${prev!.toFixed(2)}</span>}
      <span className={clsx(dropped && "aa-price-drop")}>{p.valueFormatted ?? p.value}</span>
      {dropped && <span className="text-[11px] text-ok">↓</span>}
    </span>
  );
}

export const usd = (v: unknown, digits = 2) =>
  typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }) : "";
