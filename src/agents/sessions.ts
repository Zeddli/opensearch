// Session listing + badges, session access helpers for AGENTS routes.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { chatSessions, getDb, offers, requests, type ChatSession, type User } from "@/src/db";
import { notFound } from "@/src/lib/http";

export type SessionSummary = {
  id: string;
  title: string;
  kind: ChatSession["kind"];
  status: string;
  badge?: string;
  requestId?: string | null;
  requestStatus?: string | null;
  updatedAt: string;
  createdAt: string;
};

export async function getOwnedSession(user: User, id: string): Promise<ChatSession> {
  const db = await getDb();
  const [s] = await db.select().from(chatSessions).where(and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id))).limit(1);
  if (!s) throw notFound("Session not found");
  return s;
}

export async function listSessions(user: User): Promise<SessionSummary[]> {
  const db = await getDb();
  const sessions = await db.select().from(chatSessions).where(eq(chatSessions.userId, user.id)).orderBy(desc(chatSessions.updatedAt));
  if (!sessions.length) return [];
  const base = (s: ChatSession): SessionSummary => ({
    id: s.id,
    title: s.title,
    kind: s.kind,
    status: s.status,
    updatedAt: s.updatedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  });

  if (user.role === "seller") {
    const counts = await db
      .select({ status: offers.status, n: sql<number>`count(*)::int` })
      .from(offers)
      .where(eq(offers.sellerId, user.id))
      .groupBy(offers.status);
    const by = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    const live = (by.active ?? 0) + (by.countered ?? 0) + (by.revised ?? 0);
    const badge = by.won ? `${by.won} sold ✓${live ? ` · ${live} live` : ""}` : live ? `${live} live deal${live === 1 ? "" : "s"}` : undefined;
    // badge only on the most recent seller session (where agent updates are posted)
    return sessions.map((s, i) => ({ ...base(s), badge: i === 0 ? badge : undefined }));
  }

  const reqs = await db
    .select()
    .from(requests)
    .where(inArray(requests.sessionId, sessions.map((s) => s.id)))
    .orderBy(desc(requests.createdAt));
  const reqBySession = new Map<string, (typeof reqs)[number]>();
  for (const r of reqs) if (!reqBySession.has(r.sessionId)) reqBySession.set(r.sessionId, r);
  const reqIds = [...reqBySession.values()].map((r) => r.id);
  const counts = reqIds.length
    ? await db
        .select({ requestId: offers.requestId, n: sql<number>`count(*)::int` })
        .from(offers)
        .where(inArray(offers.requestId, reqIds))
        .groupBy(offers.requestId)
    : [];
  const countBy = new Map(counts.map((c) => [c.requestId, Number(c.n)]));

  return sessions.map((s) => {
    const r = reqBySession.get(s.id);
    if (!r) return { ...base(s), badge: "new", requestId: null, requestStatus: null };
    const n = countBy.get(r.id) ?? 0;
    const offersTxt = `${n} offer${n === 1 ? "" : "s"}`;
    const badge =
      r.status === "draft"
        ? "draft"
        : r.status === "open"
          ? n
            ? `collecting · ${offersTxt}`
            : "collecting"
          : r.status === "analyzing"
            ? "analyzing"
            : r.status === "recommended"
              ? r.recommendation
                ? `${offersTxt} · pick ready`
                : "no offers"
              : r.status === "approved"
                ? "approved"
                : "paid ✓";
    return { ...base(s), badge, requestId: r.id, requestStatus: r.status };
  });
}
