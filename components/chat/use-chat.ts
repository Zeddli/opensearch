"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errMsg, fetchMessagesAfter, POLL_MS, qk, sendChat, useSession, type Message } from "@/components/api";

const isTmp = (m: Message) => m.id.startsWith("tmp-");
const byTime = (a: Message, b: Message) => {
  if (isTmp(a) !== isTmp(b)) return isTmp(a) ? 1 : -1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
};

/** Chat state for one session: initial load, optimistic send, background polling (?after=). */
export function useChat(sessionId: string) {
  const qc = useQueryClient();
  const detail = useSession(sessionId);
  const [map, setMap] = useState<Map<string, Message>>(() => new Map());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const lastRef = useRef<string | null>(null);

  const merge = useCallback((msgs: Message[], drop?: string) => {
    if (!msgs.length && !drop) return;
    setMap((prev) => {
      const next = new Map(prev);
      if (drop) next.delete(drop);
      for (const m of msgs) next.set(m.id, m);
      return next;
    });
  }, []);

  // Reset when switching sessions.
  useEffect(() => {
    setMap(new Map());
    lastRef.current = null;
    setSendError(null);
  }, [sessionId]);

  // Full detail (initial + periodic refresh catches card updates on existing messages).
  useEffect(() => {
    if (detail.data?.messages) merge(detail.data.messages);
  }, [detail.data, merge]);

  const messages = useMemo(() => [...map.values()].sort(byTime), [map]);

  useEffect(() => {
    const real = messages.filter((m) => !isTmp(m));
    lastRef.current = real.length ? real[real.length - 1].createdAt : null;
  }, [messages]);

  // Poll for agent messages produced by background jobs.
  const ready = detail.isSuccess;
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    let ctrl: AbortController | null = null;
    const tick = async () => {
      if (stop || document.hidden) return;
      ctrl = new AbortController();
      try {
        const msgs = await fetchMessagesAfter(sessionId, lastRef.current, ctrl.signal);
        if (!stop && msgs.length) {
          merge(msgs);
          // New agent output often means request/offer state changed.
          qc.invalidateQueries({ queryKey: qk.session(sessionId) });
          qc.invalidateQueries({ queryKey: qk.sessions });
        }
      } catch {
        /* route may not exist yet — keep quiet */
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
      ctrl?.abort();
    };
  }, [ready, sessionId, merge, qc]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || sending) return false;
      setSendError(null);
      const tmp: Message = {
        id: `tmp-${crypto.randomUUID()}`,
        sessionId,
        role: "user",
        content: t,
        card: null,
        createdAt: new Date().toISOString(),
      };
      merge([tmp]);
      setSending(true);
      try {
        const msgs = await sendChat(sessionId, t);
        merge(msgs, tmp.id);
        qc.invalidateQueries({ queryKey: qk.session(sessionId) });
        qc.invalidateQueries({ queryKey: qk.sessions });
        return true;
      } catch (e) {
        setSendError(errMsg(e));
        merge([], tmp.id); // roll back the optimistic message; composer restores the text
        return false;
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId, merge, qc],
  );

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: qk.session(sessionId) }), [qc, sessionId]);

  return { detail, messages, send, sending, sendError, refresh };
}

export type ChatState = ReturnType<typeof useChat>;
