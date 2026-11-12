import { and, desc, eq, sql } from "drizzle-orm";
import { chatSessions, getDb, messages, requests } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { badRequest, handle, json, notFound, readJson } from "@/src/lib/http";
import { RequestSpecSchema } from "@/src/agents/protocol";
import { requestTitle } from "@/src/agents/buyer/intake";
import { logEvent } from "@/src/agents/util";

export const dynamic = "force-dynamic";

async function ownedRequest(id: string, buyerId: string) {
  const db = await getDb();
  const [r] = await db.select().from(requests).where(and(eq(requests.id, id), eq(requests.buyerId, buyerId))).limit(1);
  if (!r) throw notFound("Request not found");
  return r;
}

export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("buyer");
  const { id } = await params;
  return json({ request: await ownedRequest(id, user.id) });
});

const Body = { parse: (v: unknown) => RequestSpecSchema.partial().extend({}).passthrough().parse((v as { spec?: unknown })?.spec ?? {}) };

/** Edit a draft request's spec (partial or full). Also updates the request_summary card in chat. */
export const PATCH = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("buyer");
  const { id } = await params;
  const existing = await ownedRequest(id, user.id);
  if (existing.status !== "draft") throw badRequest(`Request is ${existing.status}; only drafts can be edited`);
  const patch = await readJson(req, Body);
  const spec = RequestSpecSchema.parse({ ...existing.spec, ...patch });
  const db = await getDb();
  const [updated] = await db
    .update(requests)
    .set({ spec, title: requestTitle(spec), budgetMaxCents: spec.budgetMaxCents, deadline: spec.deadline, location: spec.location })
    .where(eq(requests.id, id))
    .returning();
  await db.update(chatSessions).set({ title: updated.title }).where(eq(chatSessions.id, updated.sessionId));
  const [cardMsg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, updated.sessionId), sql`${messages.card}->>'type' = 'request_summary'`, sql`${messages.card}->>'requestId' = ${id}`))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (cardMsg?.card?.type === "request_summary") {
    await db.update(messages).set({ card: { ...cardMsg.card, spec } }).where(eq(messages.id, cardMsg.id));
  }
  await logEvent({ requestId: id, actor: `buyer:${user.id}`, tool: "update_request_draft", input: patch, output: spec, decision: "edited in UI" });
  return json({ request: updated });
});
