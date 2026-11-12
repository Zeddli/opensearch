"use client";

import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ArrowRight,
  ChevronUp,
  Cog,
  Home,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  MessagesSquare,
  Plus,
  ShoppingBag,
  Settings,
  Store,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  errMsg,
  logout,
  useBuyerSettings,
  useCreateSession,
  useSellerSettings,
  useSessions,
  useStatus,
  type PublicUser,
  type SessionSummary,
} from "@/components/api";
import { Avatar, Badge, money, Spinner } from "@/components/ui";
import { UserProvider } from "./user-context";

export function AppShell({ user, children }: { user: PublicUser; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <UserProvider user={user}>
      <div className="flex h-dvh overflow-hidden bg-canvas text-fg">
        {/* Desktop sidebar */}
        <aside className="hidden w-[272px] shrink-0 border-r border-line bg-surface lg:flex">
          <Sidebar user={user} />
        </aside>

        {/* Mobile drawer */}
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
            <aside className="aa-in absolute inset-y-0 left-0 flex w-[86vw] max-w-[300px] border-r border-line bg-surface shadow-xl">
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="absolute top-3 right-3 z-10 rounded-md p-1.5 text-muted hover:bg-surface-2"
              >
                <X className="size-4" />
              </button>
              <Sidebar user={user} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 lg:hidden">
            <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-md p-1.5 text-fg-2 hover:bg-surface-2">
              <Menu className="size-5" />
            </button>
            <Logo />
          </header>
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        </div>
      </div>
    </UserProvider>
  );
}

function Logo() {
  return (
    <Link href="/home" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-fg">
        <ShoppingBag className="size-4" />
      </span>
      <span>OpenQuote</span>
    </Link>
  );
}

function Sidebar({ user }: { user: PublicUser }) {
  const router = useRouter();
  const create = useCreateSession();
  const [err, setErr] = useState<string | null>(null);

  async function newSession() {
    setErr(null);
    try {
      const s = await create.mutateAsync();
      router.push(`/s/${s.id}`);
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  const nav =
    user.role === "buyer"
      ? [
          { href: "/home", label: "Home", icon: Home },
          { href: "/forum", label: "Forum", icon: MessagesSquare },
          { href: "/settings", label: "Settings", icon: Settings },
        ]
      : [
          { href: "/home", label: "Home", icon: Home },
          { href: "/forum", label: "Opportunities", icon: MessagesSquare },
          { href: "/seller/catalog", label: "Catalog", icon: LayoutGrid },
          { href: "/settings", label: "Settings", icon: Settings },
        ];

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Logo />
      </div>

      <div className="px-3">
        <button
          onClick={newSession}
          disabled={create.isPending}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-accent text-sm font-medium text-accent-fg shadow-sm transition hover:bg-accent-hover disabled:opacity-60"
        >
          {create.isPending ? <Spinner className="text-accent-fg" /> : <Plus className="size-4" />}
          New session
        </button>
        {err && <p className="mt-1.5 text-xs text-bad">{err}</p>}
      </div>

      <AiKeyCallout />

      <NavLinks items={nav} />

      <div className="mt-3 flex items-center justify-between px-4 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
        Sessions
      </div>
      <SessionList />

      <div className="space-y-2 border-t border-line p-3">
        {user.role === "buyer" ? <WalletCard /> : <SellerCard />}
        <StatusChips />
        <UserMenu user={user} />
      </div>
    </div>
  );
}

function NavLinks({ items }: { items: Array<{ href: string; label: string; icon: typeof Home }> }) {
  const pathname = usePathname();
  return (
    <nav className="mt-3 space-y-0.5 px-2">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={clsx(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition",
              active ? "bg-surface-2 font-medium text-fg" : "text-fg-2 hover:bg-surface-2",
            )}
          >
            <Icon className={clsx("size-4", active ? "text-accent" : "text-muted")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function badgeTone(badge: string | undefined): "accent" | "ok" | "warn" | "neutral" {
  if (!badge) return "neutral";
  const b = badge.toLowerCase();
  if (b.includes("paid") || b.includes("sold") || b.includes("won")) return "ok";
  if (b.includes("collect") || b.includes("offer") || b.includes("analy")) return "accent";
  if (b.includes("approv") || b.includes("action") || b.includes("pick")) return "warn";
  return "neutral";
}

function isLive(s: SessionSummary) {
  const b = (s.badge ?? "").toLowerCase();
  return b.includes("collect") || b.includes("analy") || b.includes("negotiat");
}

function SessionList() {
  const { data, isLoading, error } = useSessions();
  const params = useParams<{ sessionId?: string }>();
  const active = params?.sessionId;

  return (
    <div className="aa-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      {isLoading && (
        <div className="space-y-1.5 px-2 py-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      )}
      {!isLoading && !data?.length && (
        <p className="px-2.5 py-2 text-xs text-muted">{error ? "Sessions unavailable right now." : "No sessions yet. Start one above."}</p>
      )}
      {data?.map((s) => (
        <Link
          key={s.id}
          href={`/s/${s.id}`}
          className={clsx(
            "group flex items-start gap-2 rounded-lg px-2.5 py-2 transition",
            active === s.id ? "bg-accent-soft" : "hover:bg-surface-2",
          )}
        >
          <span
            className={clsx(
              "mt-1.5 size-2 shrink-0 rounded-full",
              isLive(s) ? "aa-live bg-accent" : badgeTone(s.badge) === "ok" ? "bg-ok" : "bg-line-strong",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className={clsx("block truncate text-sm", active === s.id ? "font-medium text-fg" : "text-fg-2")}>
              {s.title || "New session"}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5">
              {s.badge && <Badge tone={badgeTone(s.badge)}>{s.badge}</Badge>}
              <span className="truncate text-[11px] text-muted">{safeAgo(s.updatedAt)}</span>
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}

export function safeAgo(iso: string | undefined | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

function WalletCard() {
  const { data, error } = useBuyerSettings();
  return (
    <Link href="/settings?tab=wallet" className="block rounded-xl border border-line bg-surface-2/60 p-3 transition hover:border-line-strong">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
          <Wallet className="size-3.5 text-muted" /> Wallet
        </span>
        {data ? (
          data.paypalLinked ? (
            <Badge tone="ok">PayPal linked</Badge>
          ) : (
            <Badge tone="warn">Link PayPal</Badge>
          )
        ) : (
          <Badge>{error ? "unavailable" : "…"}</Badge>
        )}
      </div>
      {data && (
        <p className="mt-1.5 text-xs text-muted">
          Auto-pay up to <span className="font-medium text-fg">{money(data.autoPayLimitCents)}</span> per order
          <span className="block">
            {money(data.spentThisMonthCents)} of {money(data.monthlyCapCents)} this month
          </span>
        </p>
      )}
    </Link>
  );
}

function SellerCard() {
  const { data, error } = useSellerSettings();
  const paypalOk = data?.payoutReady;
  return (
    <Link href="/settings?tab=store" className="block rounded-xl border border-line bg-surface-2/60 p-3 transition hover:border-line-strong">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-2">
        <Store className="size-3.5 text-muted" /> {data?.displayName || "Your store"}
      </div>
      {data ? (
        <div className="flex flex-wrap gap-1">
          <Badge tone={paypalOk ? "ok" : data.onboardingStatus === "pending" ? "warn" : "bad"}>
            PayPal {paypalOk ? "✓" : data.onboardingStatus === "pending" ? "pending" : "not connected"}
          </Badge>
          <Badge tone={data.shopifyConnected ? "ok" : "neutral"}>Shopify {data.shopifyConnected ? "✓" : "—"}</Badge>
          <Badge tone={data.autoDeal ? "accent" : "neutral"}>Auto-deal {data.autoDeal ? "on" : "off"}</Badge>
        </div>
      ) : (
        <p className="text-xs text-muted">{error ? "Settings unavailable" : "Loading…"}</p>
      )}
    </Link>
  );
}

const STATUS_LABELS = { ai: "AI key", channel3: "Channel3" } as const;
const STATUS_TITLES = {
  ai: "Your AI API key (set in Settings)",
  channel3: "Public-web price comparison on this server",
} as const;

const PAYMENTS_CHIP = {
  configured: { label: "Payments: PayPal sandbox", title: "Payments run through the PayPal sandbox", ok: true },
  missing: { label: "Payments: disabled", title: "PayPal credentials are missing on this server (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)", ok: false },
} as const;

function StatusChips() {
  const { data } = useStatus();
  if (!data) return null;
  const pay = PAYMENTS_CHIP[data.paypal];
  return (
    <div className="flex flex-wrap gap-1">
      <span
        className={clsx(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
          pay.ok ? "border-ok/30 text-ok" : "border-line text-muted",
        )}
        title={pay.title}
      >
        <span className={clsx("size-1.5 rounded-full", pay.ok ? "bg-ok" : "bg-line-strong")} />
        {pay.label}
      </span>
      {(Object.keys(STATUS_LABELS) as Array<keyof typeof STATUS_LABELS>).map((k) => {
        const ok = data[k] === "configured";
        const chip = (
          <>
            <span className={clsx("size-1.5 rounded-full", ok ? "bg-ok" : k === "ai" ? "bg-warn" : "bg-line-strong")} />
            {STATUS_LABELS[k]} {ok ? "configured" : "missing"}
          </>
        );
        const cls = clsx(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
          ok ? "border-ok/30 text-ok" : k === "ai" ? "border-warn/40 text-warn" : "border-line text-muted",
        );
        return k === "ai" ? (
          <Link key={k} href="/settings?tab=ai" className={clsx(cls, "hover:border-line-strong")} title={STATUS_TITLES[k]}>
            {chip}
          </Link>
        ) : (
          <span key={k} className={cls} title={STATUS_TITLES[k]}>
            {chip}
          </span>
        );
      })}
    </div>
  );
}

/** Prominent nudge while the current user has no AI key — without one their agent can't run. */
function AiKeyCallout() {
  const { data } = useStatus();
  const pathname = usePathname();
  if (data?.ai !== "missing") return null;
  const onAiTab = pathname === "/settings";
  return (
    <Link
      href="/settings?tab=ai"
      className={clsx(
        "mx-3 mt-3 block rounded-xl border border-warn/40 bg-warn-soft p-3 transition hover:border-warn",
        onAiTab && "pointer-events-none opacity-80",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-warn">
        <KeyRound className="size-4" /> Add your AI key
      </span>
      <span className="mt-1 block text-xs text-fg-2">Your agent needs your AI API key before it can chat, negotiate or compare offers.</span>
      {!onAiTab && (
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-warn">
          Open settings <ArrowRight className="size-3.5" />
        </span>
      )}
    </Link>
  );
}

function UserMenu({ user }: { user: PublicUser }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  async function doLogout() {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    qc.clear();
    router.push("/login");
    router.refresh();
  }

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="aa-in absolute right-0 bottom-full left-0 mb-1 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg-2 hover:bg-surface-2"
          >
            <Cog className="size-4 text-muted" /> Settings
          </Link>
          <button onClick={doLogout} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-bad hover:bg-bad-soft">
            <LogOut className="size-4" /> Log out
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-surface-2"
        aria-expanded={open}
      >
        <Avatar name={user.name} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-[11px] text-muted">
            <span className="capitalize">{user.role}</span> · {user.email}
          </span>
        </span>
        <ChevronUp className={clsx("size-4 text-muted transition", !open && "rotate-180")} />
      </button>
    </div>
  );
}
