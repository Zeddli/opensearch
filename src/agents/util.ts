// Shared helpers for agents + AGENTS routes: chat messages, forum posts, agent_events logging,
// seller chat sessions, money/date formatting.
import { and, desc, eq } from "drizzle-orm";
import {
  agentEvents,
  chatSessions,
  forumPosts,
  getDb,
  messages,
  sellerProfiles,
  users,
  type ForumPost,
  type MessageRow,
} from "@/src/db";
import type { Card, Message } from "@/src/agents/protocol";

// ---- monotonic timestamps so ordering + `?after=` polling are stable ----
const g = globalThis as unknown as { __aaLastTs?: number };
export function nextTimestamp(): Date {
  const now = Date.now();
  const last = g.__aaLastTs ?? 0;
  const ts = now > last ? now : last + 1;
  g.__aaLastTs = ts;
  return new Date(ts);
}

export function toApiMessage(m: MessageRow): Message {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    card: (m.card as Card | null) ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function addMessage(
  sessionId: string,
  role: MessageRow["role"],
  content: string,
  card: Card | null = null,
): Promise<MessageRow> {
  const db = await getDb();
  const createdAt = nextTimestamp();
  const [row] = await db.insert(messages).values({ sessionId, role, content, card, createdAt }).returning();
  await db.update(chatSessions).set({ updatedAt: createdAt }).where(eq(chatSessions.id, sessionId));
  return row;
}

export async function createPost(p: {
  requestId: string;
  authorKind: ForumPost["authorKind"];
  authorId?: string | null;
  type: ForumPost["type"];
  body: string;
  offerId?: string | null;
  replyTo?: string | null;
}): Promise<ForumPost> {
  const db = await getDb();
  const [row] = await db
    .insert(forumPosts)
    .values({
      requestId: p.requestId,
      authorKind: p.authorKind,
      authorId: p.authorId ?? null,
      type: p.type,
      body: p.body,
      offerId: p.offerId ?? null,
      replyTo: p.replyTo ?? null,
      createdAt: nextTimestamp(),
    })
    .returning();
  return row;
}

/** Log a tool action. Never throws. */
export async function logEvent(e: {
  requestId?: string | null;
  actor: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  decision?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(agentEvents).values({
      requestId: e.requestId ?? null,
      actor: e.actor,
      tool: e.tool,
      input: (e.input ?? null) as never,
      output: (e.output ?? null) as never,
      decision: e.decision ?? null,
      createdAt: nextTimestamp(),
    });
  } catch (err) {
    console.error("[agents] logEvent failed", err);
  }
}

/** The seller's most recent seller chat session (created if none). */
export async function getOrCreateSellerSession(sellerId: string): Promise<string> {
  const db = await getDb();
  const [s] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.userId, sellerId), eq(chatSessions.kind, "seller")))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(1);
  if (s) return s.id;
  const [created] = await db
    .insert(chatSessions)
    .values({ userId: sellerId, kind: "seller", title: "Seller assistant" })
    .returning();
  await addMessage(
    created.id,
    "assistant",
    "Hi! I'm your seller agent. Describe a product to add it to your catalog, or ask \"how are my deals going?\". I'll post updates here whenever I make, revise, win or lose an offer.",
  );
  return created.id;
}

export type StatusAction = { label: string; href: string };
export const SETTINGS_ACTION: StatusAction = { label: "Open settings", href: "/settings" };

/** Assistant message carrying a status card (content mirrors the card text). */
export function addStatus(sessionId: string, text: string, tone: "info" | "success" | "warning" = "info", action?: StatusAction) {
  return addMessage(sessionId, "assistant", text, { type: "status", text, tone, ...(action ? { action } : {}) });
}

/** Post a status card to the seller's chat. Never throws. */
export async function notifySeller(sellerId: string, text: string, tone: "info" | "success" | "warning" = "info", action?: StatusAction) {
  try {
    const sid = await getOrCreateSellerSession(sellerId);
    await addStatus(sid, text, tone, action);
  } catch (err) {
    console.error("[agents] notifySeller failed", err);
  }
}

export async function sellerDisplayName(sellerId: string): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({ displayName: sellerProfiles.displayName, name: users.name })
    .from(users)
    .leftJoin(sellerProfiles, eq(sellerProfiles.userId, users.id))
    .where(eq(users.id, sellerId))
    .limit(1);
  return row?.displayName || row?.name || "Seller";
}

export const usd = (cents: number | null | undefined) =>
  cents == null
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", {
        minimumFractionDigits: cents % 100 === 0 && Math.abs(cents) >= 10000 ? 0 : 2,
        maximumFractionDigits: 2,
      })}`;

export const unitUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Whole days from today until a YYYY-MM-DD date (min 0). */
export function daysUntil(dateIso: string): number {
  const target = Date.parse(`${dateIso}T23:59:59Z`);
  return Math.max(0, Math.floor((target - Date.now()) / 86_400_000));
}

export const firstName = (name: string) => name.split(/[\s—-]+/)[0] || name;

export const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Tokenize text for keyword matching. */
const STOP = new Set(
  "a an the and or of for to in on with by at from i we need want looking buy get some any my our your is are be pcs units unit per each".split(
    " ",
  ),
);
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))
    .filter((t) => t.length > 1 && !STOP.has(t));
}
