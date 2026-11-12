"use client";

import clsx from "clsx";
import { ArrowUp, Bot } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Message } from "@/components/api";
import { useUser } from "@/components/shell/user-context";
import { Avatar, ErrorNote, Spinner, ThinkingDots } from "@/components/ui";
import { CardView } from "./cards";
import type { ChatState } from "./use-chat";

export function ChatPanel({
  chat,
  sessionId,
  compact,
  emptyHint,
  agentWorking,
}: {
  chat: ChatState;
  sessionId: string;
  compact?: boolean;
  emptyHint?: ReactNode;
  agentWorking?: string | null;
}) {
  const user = useUser();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { messages, sending, sendError, detail } = chat;

  useLayoutEffect(() => {
    const el = scroller.current;
    const last = messages[messages.length - 1];
    if (last?.id.startsWith("tmp-")) stick.current = true; // the user just sent something
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending, agentWorking]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} onScroll={onScroll} className="aa-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={clsx("mx-auto space-y-4", compact ? "px-3 py-3" : "max-w-3xl px-4 py-6 sm:px-6")}>
          {detail.isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!!detail.error && !messages.length && (
            <p className="py-10 text-center text-sm text-muted">This session couldn&apos;t be loaded right now. Retrying…</p>
          )}
          {!detail.isLoading && !messages.length && !detail.error && (
            <div className="py-10 text-center">
              <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
                <Bot className="size-5" />
              </div>
              <p className="text-sm font-medium">{user.role === "buyer" ? "Tell your agent what you need" : "Tell your agent what you sell"}</p>
              <div className="mx-auto mt-1 max-w-sm text-sm text-muted">{emptyHint}</div>
            </div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m} sessionId={sessionId} compact={compact} userName={user.name} />
          ))}
          {(sending || agentWorking) && (
            <div className="flex items-center gap-2.5 pl-0.5">
              <AgentAvatar />
              <ThinkingDots label={sending ? "Agent is thinking" : agentWorking!} />
            </div>
          )}
        </div>
      </div>
      <Composer chat={chat} compact={compact} />
    </div>
  );
}

/** Minimal inline formatting for agent text: **bold** and `code`. */
function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function AgentAvatar() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
      <Bot className="size-4" />
    </span>
  );
}

function MessageRow({ m, sessionId, compact, userName }: { m: Message; sessionId: string; compact?: boolean; userName: string }) {
  if (m.role === "system" && !m.card) {
    return <p className="text-center text-xs text-muted">{m.content}</p>;
  }
  if (m.role === "user") {
    return (
      <div className="aa-in flex justify-end gap-2.5">
        <div
          className={clsx(
            "max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm whitespace-pre-wrap text-accent-fg",
            m.id.startsWith("tmp-") && "opacity-80",
          )}
        >
          {m.content}
        </div>
        {!compact && <Avatar name={userName} size={28} />}
      </div>
    );
  }
  return (
    <div className="aa-in flex gap-2.5">
      <AgentAvatar />
      <div className="min-w-0 flex-1 space-y-2">
        {m.content && <div className="max-w-[92%] text-sm leading-6 whitespace-pre-wrap text-fg">{rich(m.content)}</div>}
        {m.card && <CardView card={m.card} sessionId={sessionId} compact={compact} messageId={m.id.startsWith("tmp-") ? undefined : m.id} />}
      </div>
    </div>
  );
}

function Composer({ chat, compact }: { chat: ChatState; compact?: boolean }) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || chat.sending) return;
    setText("");
    const ok = await chat.send(t);
    if (!ok) setText(t);
  }

  return (
    <div className={clsx("shrink-0 border-t border-line bg-surface", compact ? "p-2" : "px-4 py-3 sm:px-6")}>
      <form onSubmit={submit} className={clsx("mx-auto", !compact && "max-w-3xl")}>
        {chat.sendError && <ErrorNote className="mb-2 text-xs">{chat.sendError}</ErrorNote>}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-canvas px-2 py-1.5 focus-within:border-accent">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Message your agent…"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-fg outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!text.trim() || chat.sending}
            aria-label="Send"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg transition hover:bg-accent-hover disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
