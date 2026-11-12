import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentEvents, forumPosts, getDb, offers, requests, sellerProfiles, users } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json, notFound } from "@/src/lib/http";
import { firstName } from "@/src/agents/util";

export const dynamic = "force-dynamic";

/** One forum thread: request + posts (with authorName and, for offer posts, the structured offer chip). */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ requestId: string }> }) => {
  const user = await requireUser();
  const { requestId } = await params;
  const db = await getDb();
  const [row] = await db
    .select({ request: requests, buyerName: users.name })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.buyerId))
    .where(eq(requests.id, requestId))
    .limit(1);
  if (!row || (row.request.status === "draft" && row.request.buyerId !== user.id)) throw notFound("Request not found");
  const r = row.request;
  const posts = await db.select().from(forumPosts).where(eq(forumPosts.requestId, requestId)).orderBy(asc(forumPosts.createdAt));

  const sellerIds = [...new Set(posts.filter((p) => p.authorKind === "seller_agent" && p.authorId).map((p) => p.authorId!))];
  const sellers = sellerIds.length
    ? await db.select({ id: sellerProfiles.userId, name: sellerProfiles.displayName }).from(sellerProfiles).where(inArray(sellerProfiles.userId, sellerIds))
    : [];
  const sellerName = new Map(sellers.map((s) => [s.id, s.name]));
  const offerIds = [...new Set(posts.map((p) => p.offerId).filter((x): x is string => Boolean(x)))];
  const offerRows = offerIds.length ? await db.select().from(offers).where(inArray(offers.id, offerIds)) : [];
  const offerById = new Map(offerRows.map((o) => [o.id, o]));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(offers).where(eq(offers.requestId, requestId));

  // Per-post snapshots from agent_events: the opening terms of each offer, and each counter's targets.
  const events = await db
    .select({ tool: agentEvents.tool, input: agentEvents.input, output: agentEvents.output })
    .from(agentEvents)
    .where(and(eq(agentEvents.requestId, requestId), inArray(agentEvents.tool, ["make_offer", "send_counter"])));
  type MakeIn = { unitPriceCents: number; quantity: number; shippingCents: number; etaDays: number };
  const original = new Map<string, MakeIn & { totalCents: number }>();
  const counterByPost = new Map<string, { targetUnitPriceCents: number | null; targetEtaDays: number | null }>();
  for (const e of events) {
    const out = (e.output ?? {}) as Record<string, unknown>;
    const inp = (e.input ?? {}) as Record<string, unknown>;
    if (e.tool === "make_offer" && typeof out.offerId === "string") {
      original.set(out.offerId, { ...(inp as MakeIn), totalCents: Number(out.totalCents) });
    } else if (e.tool === "send_counter" && typeof out.postId === "string") {
      counterByPost.set(out.postId, {
        targetUnitPriceCents: typeof inp.targetUnitPriceCents === "number" ? inp.targetUnitPriceCents : null,
        targetEtaDays: typeof inp.targetEtaDays === "number" ? inp.targetEtaDays : null,
      });
    }
  }

  const buyerAgentName = `${firstName(row.buyerName)}'s agent`;
  const out = posts.map((p) => {
    const authorName =
      p.authorKind === "buyer_agent" ? buyerAgentName : p.authorKind === "seller_agent" ? `${sellerName.get(p.authorId ?? "") ?? "Seller"} agent` : "OpenQuote";
    const o = p.offerId ? offerById.get(p.offerId) : undefined;
    return {
      ...p,
      authorName,
      offer: o
        ? {
            id: o.id,
            unitPriceCents: o.unitPriceCents,
            quantity: o.quantity,
            shippingCents: o.shippingCents,
            totalCents: o.totalCents,
            etaDays: o.etaDays,
            warranty: o.warranty,
            returnPolicy: o.returnPolicy,
            status: o.status,
            version: o.version,
          }
        : null,
      // offer posts: terms as first offered (differs from `offer` once revised)
      original: p.type === "offer" && p.offerId ? (original.get(p.offerId) ?? null) : null,
      // counter posts: what the buyer agent asked for
      counter: p.type === "counter" ? (counterByPost.get(p.id) ?? null) : null,
    };
  });
  return json({
    request: {
      id: r.id,
      title: r.title,
      status: r.status,
      spec: r.spec,
      deadline: r.deadline,
      location: r.location,
      budgetMaxCents: r.budgetMaxCents,
      windowEndsAt: r.windowEndsAt,
      createdAt: r.createdAt,
      buyerName: row.buyerName,
      offerCount: Number(n),
      mine: r.buyerId === user.id,
    },
    posts: out,
  });
});
