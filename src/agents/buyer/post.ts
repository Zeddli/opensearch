// Buyer agent tool: post_request — publish a draft request to the forum.
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, messages, requests, users, type MessageRow, type RequestRow } from "@/src/db";
import { env } from "@/src/lib/env";
import { badRequest, notFound } from "@/src/lib/http";
import type { RequestSpec } from "@/src/agents/protocol";
import { onRequestPosted } from "@/src/agents/hooks";
import { addMessage, createPost, firstName, logEvent, usd } from "@/src/agents/util";

export function requestPostBody(spec: RequestSpec, buyerName: string): string {
  const lines = [
    `📦 Looking for: ${spec.quantity} × ${spec.item}${spec.unit ? ` (${spec.unit})` : ""}`,
    `💰 Budget: ${spec.budgetMaxCents > 0 ? `up to ${usd(spec.budgetMaxCents)} total incl. shipping` : "flexible"}`,
    `📅 Deliver by: ${spec.deadline}`,
    `📍 Deliver to: ${spec.location}`,
  ];
  if (spec.mustHave.length) lines.push(`✅ Must have: ${spec.mustHave.join(", ")}`);
  if (spec.niceToHave.length) lines.push(`✨ Nice to have: ${spec.niceToHave.join(", ")}`);
  lines.push(`Posted by ${firstName(buyerName)}'s agent — structured offers only, please.`);
  return lines.join("\n");
}

export async function publishRequest(
  requestId: string,
  buyerId: string,
  opts: { windowSeconds?: number } = {},
): Promise<{ request: RequestRow; messages: MessageRow[] }> {
  const db = await getDb();
  const [req] = await db.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.buyerId, buyerId))).limit(1);
  if (!req) throw notFound("Request not found");
  if (req.status !== "draft") throw badRequest(`Request is already ${req.status}`);
  const [buyer] = await db.select({ name: users.name }).from(users).where(eq(users.id, buyerId)).limit(1);

  const windowSeconds = Math.max(10, Math.min(3600, Math.round(opts.windowSeconds ?? env.OFFER_WINDOW_SECONDS)));
  const windowEndsAt = new Date(Date.now() + windowSeconds * 1000);
  const [updated] = await db
    .update(requests)
    .set({ status: "open", windowEndsAt })
    .where(and(eq(requests.id, requestId), eq(requests.status, "draft")))
    .returning();
  if (!updated) throw badRequest("Request is no longer a draft");

  await createPost({
    requestId,
    authorKind: "buyer_agent",
    authorId: buyerId,
    type: "request",
    body: requestPostBody(updated.spec, buyer?.name ?? "Buyer"),
  });

  // Mark the latest summary card for this request as posted.
  const [cardMsg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, req.sessionId), sql`${messages.card}->>'type' = 'request_summary'`, sql`${messages.card}->>'requestId' = ${requestId}`))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (cardMsg?.card?.type === "request_summary") {
    await db
      .update(messages)
      .set({ card: { ...cardMsg.card, spec: updated.spec, posted: true } })
      .where(eq(messages.id, cardMsg.id));
  }

  const text = `Posted to the forum! Collecting offers for ${windowSeconds}s — seller agents are reading your request now. I'll analyse every offer, compare with public web listings, negotiate with the best two, and come back with a recommendation.`;
  const msg = await addMessage(req.sessionId, "assistant", text, { type: "status", text: `Collecting offers · window closes in ${windowSeconds}s`, tone: "info" });

  await logEvent({
    requestId,
    actor: "buyer_agent",
    tool: "post_request",
    input: { requestId, windowSeconds },
    output: { windowEndsAt: windowEndsAt.toISOString() },
    decision: "published",
  });
  await onRequestPosted(requestId);
  return { request: updated, messages: [msg] };
}
