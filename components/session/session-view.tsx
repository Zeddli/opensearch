"use client";

import clsx from "clsx";
import { ChevronDown, Handshake, LayoutGrid, MessageSquare, MessagesSquare, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, type RequestRow } from "@/components/api";
import { ChatPanel } from "@/components/chat/chat-panel";
import { useChat, type ChatState } from "@/components/chat/use-chat";
import { ForumThread } from "@/components/forum/thread";
import { GlobalForum } from "@/components/forum/global-forum";
import { DealsGrid, OffersGrid } from "@/components/grids";
import { takePrompt } from "@/components/home/home-dashboard";
import { useUser } from "@/components/shell/user-context";
import { Badge, EmptyState } from "@/components/ui";

type Tab = "chat" | "forum" | "offers" | "deals";

const REQUEST_STATUS: Record<string, { label: string; tone: "accent" | "ok" | "warn" | "neutral" }> = {
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Collecting offers", tone: "accent" },
  analyzing: { label: "Analyzing", tone: "warn" },
  recommended: { label: "Recommendation ready", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  paid: { label: "Paid ✓", tone: "ok" },
  closed: { label: "Completed", tone: "ok" },
};

function useCountdown(iso: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const left = Math.round((new Date(iso).getTime() - now) / 1000);
  return Number.isFinite(left) ? Math.max(0, left) : null;
}

export function agentWorkingText(req: RequestRow | null | undefined, secondsLeft: number | null) {
  if (!req) return null;
  if (req.status === "open") return secondsLeft ? `Collecting offers from seller agents · ${secondsLeft}s left` : "Collecting offers from seller agents";
  if (req.status === "analyzing") return "Comparing offers with the public web";
  return null;
}

export function SessionView({ sessionId }: { sessionId: string }) {
  const user = useUser();
  const isBuyer = user.role === "buyer";
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabs: Tab[] = isBuyer ? ["chat", "forum", "offers"] : ["chat", "forum", "deals"];
  const raw = sp.get("tab") as Tab | null;
  const tab: Tab = raw && tabs.includes(raw) ? raw : "chat";

  const chat = useChat(sessionId);
  const req = chat.detail.data?.request ?? null;
  const secondsLeft = useCountdown(req?.status === "open" ? req.windowEndsAt : null);
  const working = agentWorkingText(req, secondsLeft);

  // Send a prompt handed over from the home page quick start (once).
  const sentRef = useRef(false);
  useEffect(() => {
    if (sentRef.current || !chat.detail.isSuccess) return;
    sentRef.current = true;
    const p = takePrompt(sessionId);
    if (p && chat.messages.length === 0) chat.send(p);
  }, [chat.detail.isSuccess, sessionId, chat]);

  const setTab = (t: Tab) => {
    const p = new URLSearchParams(sp.toString());
    if (t === "chat") p.delete("tab");
    else p.set("tab", t);
    const qs = p.toString();
    // Shallow URL update (Next syncs useSearchParams with history.replaceState) — instant tab switch.
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  };

  const title = req?.title || chat.detail.data?.session?.title || "New session";
  const st = req ? REQUEST_STATUS[req.status] : null;
  const notFound = chat.detail.error instanceof ApiError && chat.detail.error.status === 404;

  if (notFound) {
    return (
      <EmptyState title="Session not found" className="h-full" action={<Link href="/home" className="text-sm font-medium text-accent hover:underline">Back home</Link>}>
        This session doesn&apos;t exist or isn&apos;t yours.
      </EmptyState>
    );
  }

  const offersCount = (chat.detail.data?.session?.badge ?? "").match(/(\d+)\s+offer/)?.[1];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="flex items-center gap-3 px-4 pt-3 sm:px-6">
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{title}</h1>
          {st && <Badge tone={st.tone}>{st.label}</Badge>}
          {secondsLeft !== null && secondsLeft > 0 && <span className="hidden text-xs text-muted tabular-nums sm:inline">window closes in {secondsLeft}s</span>}
        </div>
        <nav className="mt-2 flex gap-1 px-3 sm:px-5" role="tablist">
          {tabs.map((t) => {
            const Icon = t === "chat" ? MessageSquare : t === "forum" ? MessagesSquare : t === "offers" ? LayoutGrid : Handshake;
            const label = t === "chat" ? "Chat" : t === "forum" ? (isBuyer ? "Forum" : "Opportunities") : t === "offers" ? "Offers" : "Deals";
            return (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={clsx(
                  "relative flex items-center gap-1.5 px-2.5 pt-1.5 pb-2.5 text-sm transition",
                  tab === t ? "font-medium text-fg" : "text-muted hover:text-fg",
                )}
              >
                <Icon className="size-4" />
                {label}
                {t === "offers" && offersCount && <Badge tone="accent">{offersCount}</Badge>}
                {tab === t && <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-accent" />}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {tab === "chat" && (
            <ChatPanel
              chat={chat}
              sessionId={sessionId}
              agentWorking={working}
              emptyHint={
                isBuyer
                  ? "Describe the item, quantity, budget, deadline and delivery location — your agent will ask about anything missing."
                  : "Describe a product: price, stock, MOQ, lead time and the lowest price you'd accept."
              }
            />
          )}
          {tab === "forum" &&
            (isBuyer ? (
              <div className="aa-scroll h-full overflow-y-auto">
                <div className="mx-auto max-w-3xl p-4 sm:p-6">
                  {req && req.status !== "draft" ? (
                    <ForumThread requestId={req.id} />
                  ) : (
                    <EmptyState icon={<MessagesSquare className="size-5" />} title="Not posted yet">
                      Once you confirm the request summary in chat, your agent posts it here and seller agents start replying.
                    </EmptyState>
                  )}
                </div>
              </div>
            ) : (
              <GlobalForum embedded />
            ))}
          {tab === "offers" && (
            <div className="h-full p-3 sm:p-4">
              {req && req.status !== "draft" ? (
                <OffersGrid requestId={req.id} quantity={req.spec?.quantity ?? 1} recommendation={req.recommendation} />
              ) : (
                <EmptyState icon={<LayoutGrid className="size-5" />} title="No offers yet">
                  Post your request to the forum to start collecting offers.
                </EmptyState>
              )}
            </div>
          )}
          {tab === "deals" && (
            <div className="h-full p-3 sm:p-4">
              <DealsGrid />
            </div>
          )}
        </div>

        {tab !== "chat" && <SideChat key={tab} chat={chat} sessionId={sessionId} working={working} startCollapsed={tab !== "forum"} />}
      </div>
    </div>
  );
}

/** Compact chat beside Forum/Offers/Deals: a column on desktop, a bottom sheet on mobile. */
function SideChat({ chat, sessionId, working, startCollapsed }: { chat: ChatState; sessionId: string; working: string | null; startCollapsed?: boolean }) {
  const [open, setOpen] = useState(false); // mobile sheet
  const [collapsed, setCollapsed] = useState(Boolean(startCollapsed)); // desktop column (grids get the width by default)
  const last = [...chat.messages].reverse().find((m) => m.role === "assistant");

  return (
    <>
      <aside className={clsx("hidden min-h-0 shrink-0 flex-col border-l border-line bg-surface xl:flex", collapsed ? "w-11" : "w-[340px]")}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          {!collapsed && <span className="text-xs font-medium text-muted">Chat with your agent</span>}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto rounded-md p-1 text-muted hover:bg-surface-2"
            aria-label={collapsed ? "Expand chat" : "Collapse chat"}
          >
            {collapsed ? <MessageSquare className="size-4" /> : <X className="size-4" />}
          </button>
        </div>
        {!collapsed && (
          <div className="min-h-0 flex-1">
            <ChatPanel chat={chat} sessionId={sessionId} compact agentWorking={working} />
          </div>
        )}
      </aside>

      {/* Mobile / tablet: peek bar + sheet */}
      <div className="xl:hidden">
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="fixed right-3 bottom-3 left-3 z-30 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left shadow-lg sm:left-auto sm:w-[360px]"
          >
            <MessageSquare className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{working ?? (last?.content?.replaceAll("**", "") || "Chat with your agent")}</span>
            <ChevronDown className="size-4 rotate-180 text-muted" />
          </button>
        )}
        {open && (
          <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/30" onClick={() => setOpen(false)}>
            <div className="aa-in flex h-[75dvh] flex-col rounded-t-2xl bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex h-11 shrink-0 items-center border-b border-line px-4">
                <span className="text-sm font-medium">Chat with your agent</span>
                <button onClick={() => setOpen(false)} className="ml-auto rounded-md p-1 text-muted hover:bg-surface-2" aria-label="Close chat">
                  <ChevronDown className="size-5" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ChatPanel chat={chat} sessionId={sessionId} compact agentWorking={working} />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
