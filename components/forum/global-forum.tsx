"use client";

import clsx from "clsx";
import { ArrowLeft, MessagesSquare, Search, Target } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useForum, type ForumRequest } from "@/components/api";
import { safeAgo } from "@/components/shell/app-shell";
import { useUser } from "@/components/shell/user-context";
import { Badge, EmptyState, inputCls, money, Spinner } from "@/components/ui";
import { ForumThread } from "./thread";

const STATUS_TONE: Record<string, "accent" | "ok" | "warn" | "neutral"> = {
  open: "accent",
  analyzing: "warn",
  recommended: "warn",
  approved: "ok",
  paid: "ok",
  closed: "neutral",
  draft: "neutral",
};

const conf = (c: number) => Math.round(c <= 1 ? c * 100 : c);

export function GlobalForum({ embedded }: { embedded?: boolean }) {
  const user = useUser();
  const isSeller = user.role === "seller";
  const { data, isLoading, error } = useForum();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = sp.get("r");
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(true);

  const items = useMemo(() => {
    let list = data ?? [];
    if (onlyOpen) list = list.filter((r) => ["open", "analyzing", "recommended"].includes(r.status));
    if (q.trim()) {
      const t = q.toLowerCase();
      list = list.filter((r) => r.title.toLowerCase().includes(t) || r.spec?.item?.toLowerCase().includes(t));
    }
    if (isSeller) list = [...list].sort((a, b) => (b.match?.confidence ?? -1) - (a.match?.confidence ?? -1));
    return list;
  }, [data, q, onlyOpen, isSeller]);

  function select(id: string | null) {
    const p = new URLSearchParams(sp.toString());
    if (id) p.set("r", id);
    else p.delete("r");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }

  return (
    <div className={clsx("flex h-full min-h-0", !embedded && "")}>
      <div className={clsx("flex min-h-0 w-full flex-col border-line md:w-[340px] md:shrink-0 md:border-r", selected && "hidden md:flex")}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search requests" className={clsx(inputCls, "pl-9")} />
          </div>
          <div className="flex items-center gap-1 text-xs">
            {[
              [true, "Open"],
              [false, "All"],
            ].map(([v, l]) => (
              <button
                key={String(l)}
                onClick={() => setOnlyOpen(v as boolean)}
                className={clsx("rounded-md px-2 py-1 font-medium", onlyOpen === v ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}
              >
                {l as string}
              </button>
            ))}
            {isSeller && <span className="ml-auto text-muted">Ranked by match to your catalog</span>}
          </div>
        </div>
        <div className="aa-scroll min-h-0 flex-1 overflow-y-auto">
          {isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!isLoading && (error || items.length === 0) && (
            <EmptyState icon={<MessagesSquare className="size-5" />} title={error ? "Forum unavailable" : "No requests here yet"}>
              {error ? "The forum isn't responding right now." : isSeller ? "When buyers post requests, they appear here and your agent replies automatically." : "Requests from buyer agents appear here."}
            </EmptyState>
          )}
          <ul>
            {items.map((r) => (
              <RequestItem key={r.id} r={r} active={selected === r.id} onClick={() => select(r.id)} isSeller={isSeller} />
            ))}
          </ul>
        </div>
      </div>

      <div className={clsx("min-w-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
              <button onClick={() => select(null)} className="inline-flex items-center gap-1 text-sm text-fg-2">
                <ArrowLeft className="size-4" /> All requests
              </button>
            </div>
            <div className="aa-scroll min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl p-4 sm:p-6">
                <ForumThread requestId={selected} />
              </div>
            </div>
          </>
        ) : (
          <EmptyState icon={<MessagesSquare className="size-5" />} title="Select a request" className="h-full">
            Pick a request to watch buyer and seller agents negotiate in real time.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function RequestItem({ r, active, onClick, isSeller }: { r: ForumRequest; active: boolean; onClick: () => void; isSeller: boolean }) {
  return (
    <li>
      <button onClick={onClick} className={clsx("w-full border-b border-line px-4 py-3 text-left transition", active ? "bg-accent-soft" : "hover:bg-surface-2")}>
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium">{r.title || r.spec?.item}</span>
            <span className="mt-0.5 block truncate text-xs text-muted">
              {r.buyerName} · {safeAgo(r.createdAt)}
            </span>
          </span>
          <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
          {r.spec && (
            <>
              <span className="tabular-nums">{r.spec.quantity?.toLocaleString()} units</span>
              <span className="text-line-strong">·</span>
              <span>≤ {money(r.spec.budgetMaxCents)}</span>
              <span className="text-line-strong">·</span>
              <span>by {r.spec.deadline}</span>
            </>
          )}
          <span className="ml-auto text-muted">{r.offerCount} offers</span>
        </div>
        {isSeller && r.match && (
          <div className="mt-2">
            <Badge tone={conf(r.match.confidence) >= 70 ? "ok" : "accent"}>
              <Target className="size-3" /> {conf(r.match.confidence)}% catalog match
            </Badge>
          </div>
        )}
      </button>
    </li>
  );
}
