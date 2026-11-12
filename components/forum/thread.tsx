"use client";

import clsx from "clsx";
import { ArrowDownRight, CornerDownRight, HelpCircle, MessageCircleReply, RefreshCw, Send, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { useOffers, useThread, type ForumPost, type Offer, type RequestRow } from "@/components/api";
import { safeAgo } from "@/components/shell/app-shell";
import { Avatar, Badge, EmptyState, money, Spinner } from "@/components/ui";

type OfferLite = Pick<Offer, "unitPriceCents" | "quantity" | "totalCents" | "etaDays" | "warranty"> & Partial<Offer>;
type PostWithOffer = ForumPost & { offer?: OfferLite | null };

export function ForumThread({ requestId, compact, filterOfferId }: { requestId: string; compact?: boolean; filterOfferId?: string }) {
  const thread = useThread(requestId);
  const offers = useOffers(requestId);
  const offerMap = new Map((offers.data?.offers ?? []).map((o) => [o.id, o]));

  if (thread.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (thread.error || !thread.data) {
    return <EmptyState title="Thread unavailable" className="py-8">The forum for this request can&apos;t be loaded right now.</EmptyState>;
  }

  let posts = thread.data.posts as PostWithOffer[];
  if (filterOfferId) {
    const ids = new Set(posts.filter((p) => p.offerId === filterOfferId).map((p) => p.id));
    posts = posts.filter((p) => p.offerId === filterOfferId || (p.replyTo && ids.has(p.replyTo)) || ids.has(p.id));
  }

  return (
    <div className={clsx("space-y-3", compact && "space-y-2")}>
      {!filterOfferId && thread.data.request && <RequestHeader request={thread.data.request} />}
      {posts.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">{filterOfferId ? "No thread messages for this offer yet." : "Waiting for seller agents…"}</p>
      )}
      {posts.map((p) => (
        <PostView key={p.id} post={p} offer={p.offer ?? (p.offerId ? offerMap.get(p.offerId) : undefined)} compact={compact} />
      ))}
    </div>
  );
}

function RequestHeader({ request }: { request: RequestRow }) {
  const s = request.spec;
  if (!s) return null;
  return (
    <div className="rounded-xl border border-accent-line bg-accent-soft/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">Request</Badge>
        <Badge>{request.status}</Badge>
        <span className="text-xs text-muted">{safeAgo(request.createdAt)}</span>
      </div>
      <p className="mt-2 font-medium">{request.title || s.item}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
        <span>
          Qty <b className="tabular-nums">{s.quantity.toLocaleString()}</b>
        </span>
        <span>
          Budget <b>≤ {money(s.budgetMaxCents)}</b>
        </span>
        <span>
          By <b>{s.deadline}</b>
        </span>
        <span>
          To <b>{s.location}</b>
        </span>
      </div>
      {s.mustHave?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.mustHave.map((m) => (
            <Badge key={m}>{m}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_META: Record<ForumPost["type"], { label: string; tone: "accent" | "ok" | "warn" | "bad" | "neutral"; icon: ReactNode }> = {
  request: { label: "Request", tone: "accent", icon: <Send className="size-3" /> },
  offer: { label: "Offer", tone: "ok", icon: <Tag className="size-3" /> },
  question: { label: "Question", tone: "warn", icon: <HelpCircle className="size-3" /> },
  answer: { label: "Answer", tone: "neutral", icon: <MessageCircleReply className="size-3" /> },
  counter: { label: "Counter-offer", tone: "accent", icon: <ArrowDownRight className="size-3" /> },
  revision: { label: "Revised offer", tone: "ok", icon: <RefreshCw className="size-3" /> },
  system: { label: "System", tone: "neutral", icon: null },
};

export function PostView({ post, offer, compact }: { post: PostWithOffer; offer?: OfferLite; compact?: boolean }) {
  if (post.type === "system" || post.authorKind === "system") {
    return (
      <div className="flex items-center gap-3 py-1 text-xs text-muted">
        <span className="h-px flex-1 bg-line" />
        <span className="max-w-[80%] text-center">{post.body}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  const meta = TYPE_META[post.type] ?? TYPE_META.answer;
  const isBuyer = post.authorKind === "buyer_agent";
  const name = post.authorName ?? (isBuyer ? "Buyer agent" : "Seller agent");
  const indent = post.type === "answer" || (post.replyTo && post.type !== "revision" && post.type !== "offer");

  return (
    <div className={clsx("aa-in flex gap-3", indent && !compact && "pl-8")}>
      {indent && !compact && <CornerDownRight className="-ml-6 mt-2 size-4 shrink-0 text-line-strong" />}
      <Avatar name={name} size={compact ? 26 : 32} kind={isBuyer ? "buyer" : "seller"} />
      <div
        className={clsx(
          "min-w-0 flex-1 rounded-xl border px-3.5 py-2.5",
          isBuyer ? "border-accent-line/70 bg-accent-soft/30" : "border-line bg-surface",
          post.type === "question" && "border-warn/30",
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{name}</span>
          <Badge tone={isBuyer ? "accent" : "neutral"}>{isBuyer ? "Buyer agent" : "Seller agent"}</Badge>
          <Badge tone={meta.tone}>
            {meta.icon}
            {meta.label}
          </Badge>
          <span className="ml-auto text-[11px] text-muted">{safeAgo(post.createdAt)}</span>
        </div>
        <p className="mt-1.5 text-sm leading-6 whitespace-pre-wrap text-fg-2">{post.body}</p>
        {offer && (post.type === "offer" || post.type === "revision") && <OfferChip offer={offer} />}
      </div>
    </div>
  );
}

export function OfferChip({ offer }: { offer: OfferLite }) {
  const items: Array<[string, string]> = [
    ["Unit", money(offer.unitPriceCents, { precise: true })],
    ["Qty", offer.quantity.toLocaleString()],
    ["Total", money(offer.totalCents)],
    ["ETA", `${offer.etaDays}d`],
    ["Warranty", offer.warranty || "none"],
  ];
  return (
    <div className="mt-2.5 inline-flex max-w-full flex-wrap items-stretch overflow-hidden rounded-lg border border-line bg-surface-2/70 text-xs">
      {items.map(([k, v], i) => (
        <span key={k} className={clsx("flex flex-col px-2.5 py-1", i > 0 && "border-l border-line")}>
          <span className="text-[10px] text-muted uppercase">{k}</span>
          <span className={clsx("font-medium tabular-nums", k === "Total" && "text-fg")}>{v}</span>
        </span>
      ))}
      {offer.version && offer.version > 1 && (
        <span className="flex items-center border-l border-line px-2.5">
          <Badge tone="ok">v{offer.version}</Badge>
        </span>
      )}
    </div>
  );
}
