"use client";

import clsx from "clsx";
import { Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

// ---------- formatting ----------

export const money = (cents: number | null | undefined, opts?: { precise?: boolean }) => {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  const v = cents / 100;
  const precise = opts?.precise ?? (Math.abs(v) < 10 || !Number.isInteger(v));
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: precise ? 2 : 0,
    maximumFractionDigits: 2,
  });
};

export const pct = (v: number | null | undefined) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const n = v <= 1 ? v * 100 : v;
  return `${Math.round(n)}%`;
};

/** Normalize a 0..1 or 0..100 score to 0..100. */
export const score100 = (v: number | null | undefined) => (v === null || v === undefined ? null : v <= 1 ? v * 100 : v);

export function initials(name: string | undefined | null) {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

const HUES = [250, 200, 160, 30, 330, 280, 100, 10];
export function hueFor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

// ---------- primitives ----------

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "paypal";
export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover",
        variant === "secondary" && "border border-line bg-surface text-fg hover:bg-surface-2",
        variant === "ghost" && "text-fg-2 hover:bg-surface-2",
        variant === "danger" && "border border-line bg-surface text-bad hover:bg-bad-soft",
        variant === "paypal" && "bg-paypal-gold text-[#111] shadow-sm hover:brightness-95",
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap",
        tone === "neutral" && "bg-surface-2 text-fg-2",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "bad" && "bg-bad-soft text-bad",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("rounded-xl border border-line bg-surface", className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("size-4 animate-spin text-muted", className)} />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-full bg-surface-2 text-muted">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx("rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad", className)}>{children}</p>;
}

export const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent-soft";

export function Field({
  label,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className={clsx("block text-xs font-medium text-fg-2", className)}>
      {label}
      <input {...rest} className={clsx(inputCls, "mt-1")} />
      {hint && <span className="mt-1 block text-[11px] font-normal text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition disabled:opacity-50",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span className={clsx("inline-block size-5 rounded-full bg-white shadow transition", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Avatar({ name, size = 28, kind }: { name: string; size?: number; kind?: "buyer" | "seller" | "system" }) {
  const hue = hueFor(name || "x");
  return (
    <span
      aria-hidden
      className={clsx("inline-grid shrink-0 place-items-center rounded-full font-semibold text-white", kind === "buyer" && "ring-2 ring-accent-line")}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.38),
        background: kind === "system" ? "var(--color-muted)" : `oklch(0.62 0.13 ${hue})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  children,
  className,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  // Portal to <body>: grids and animated rows use transforms that would trap position:fixed.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={clsx("aa-in relative w-full max-w-md rounded-t-2xl bg-surface shadow-2xl sm:rounded-2xl", className)}
      >
        <button onClick={onClose} aria-label="Close" className="absolute top-3 right-3 rounded-md p-1 text-muted hover:bg-surface-2">
          <X className="size-4" />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ThinkingDots({ label = "Agent is thinking" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="inline-flex gap-1">
        <span className="aa-dot size-1.5 rounded-full bg-accent" />
        <span className="aa-dot size-1.5 rounded-full bg-accent" />
        <span className="aa-dot size-1.5 rounded-full bg-accent" />
      </span>
      {label}
    </span>
  );
}

export function useIsDark() {
  // Tracks prefers-color-scheme (the app follows the OS theme).
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(prefers-color-scheme: dark)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
}
