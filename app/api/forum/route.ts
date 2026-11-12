import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getDb, offers, products, requests, users } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { MATCH_THRESHOLD, scoreMatch } from "@/src/agents/seller/match";

export const dynamic = "force-dynamic";

/** Public forum list (non-draft requests). Sellers get `match` against their catalog + `replied`. ?status=open filters. */
export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const db = await getDb();
  const status = new URL(req.url).searchParams.get("status");
  const rows = await db
    .select({
      id: requests.id,
      title: requests.title,
      status: requests.status,
      spec: requests.spec,
      windowEndsAt: requests.windowEndsAt,
      createdAt: requests.createdAt,
      buyerId: requests.buyerId,
      buyerName: users.name,
      offerCount: sql<number>`(select count(*)::int from ${offers} where ${offers.requestId} = ${requests.id})`,
    })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.buyerId))
    .where(status ? and(ne(requests.status, "draft"), eq(requests.status, status as "open")) : ne(requests.status, "draft"))
    .orderBy(desc(requests.createdAt))
    .limit(100);

  let out = rows.map((r) => ({ ...r, offerCount: Number(r.offerCount), mine: r.buyerId === user.id }));
  if (user.role === "seller") {
    const catalog = await db.select().from(products).where(and(eq(products.sellerId, user.id), eq(products.active, true)));
    const myOffers = await db.select({ requestId: offers.requestId, id: offers.id, status: offers.status }).from(offers).where(eq(offers.sellerId, user.id));
    const withMatch = out.map((r) => {
      let best: { productId: string; productTitle: string; confidence: number } | undefined;
      for (const p of catalog) {
        const c = scoreMatch(r.spec, p);
        if (c >= MATCH_THRESHOLD && (!best || c > best.confidence)) best = { productId: p.id, productTitle: p.title, confidence: c };
      }
      const mineOffer = myOffers.find((o) => o.requestId === r.id);
      return { ...r, match: best, replied: Boolean(mineOffer), myOfferId: mineOffer?.id ?? null, myOfferStatus: mineOffer?.status ?? null };
    });
    withMatch.sort((a, b) => (b.match?.confidence ?? 0) - (a.match?.confidence ?? 0) || b.createdAt.getTime() - a.createdAt.getTime());
    return json({ requests: withMatch.map(({ buyerId: _b, ...r }) => (void _b, r)) });
  }
  return json({ requests: out.map(({ buyerId: _b, ...r }) => (void _b, r)) });
});
