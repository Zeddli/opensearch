import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, marketListings, offers, products, requests, sellerProfiles, users } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json, notFound } from "@/src/lib/http";
import { paymentsReady } from "@/src/agents/buyer/score";
import { daysUntil } from "@/src/agents/util";

export const dynamic = "force-dynamic";

/** Offers grid data for the buyer: offers (+ seller/product info), Channel3 listings, recommendation. */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("buyer");
  const { id } = await params;
  const db = await getDb();
  const [r] = await db.select().from(requests).where(and(eq(requests.id, id), eq(requests.buyerId, user.id))).limit(1);
  if (!r) throw notFound("Request not found");
  const rows = await db
    .select({ offer: offers, productTitle: products.title, seller: sellerProfiles, sellerUserName: users.name })
    .from(offers)
    .leftJoin(products, eq(products.id, offers.productId))
    .leftJoin(sellerProfiles, eq(sellerProfiles.userId, offers.sellerId))
    .leftJoin(users, eq(users.id, offers.sellerId))
    .where(eq(offers.requestId, id))
    .orderBy(desc(offers.aiScore), asc(offers.createdAt));
  const days = daysUntil(r.deadline);
  const out = rows.map((x) => ({
    ...x.offer,
    sellerName: x.seller?.displayName ?? x.sellerUserName ?? "Seller",
    sellerRating: x.seller?.rating ?? null,
    productTitle: x.productTitle ?? "",
    meetsDeadline: x.offer.etaDays <= days,
    paymentsReady: paymentsReady(x.seller),
  }));
  const listings = await db.select().from(marketListings).where(eq(marketListings.requestId, id)).orderBy(asc(marketListings.estTotalCents));
  return json({ offers: out, listings, recommendation: r.recommendation, request: { id: r.id, status: r.status, windowEndsAt: r.windowEndsAt, deadline: r.deadline, budgetMaxCents: r.budgetMaxCents } });
});
