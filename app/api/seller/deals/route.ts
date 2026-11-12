// GET /api/seller/deals → {deals:[{offerId, requestId, requestTitle, buyerName, status, unitPriceCents,
//   quantity, totalCents, budgetMaxCents, competingOffers, updatedAt, ...}]}
// Offers made by this seller. Competitor prices are never exposed — only a count.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb, offers, products, requests, users } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";

export const GET = handle(async () => {
  const user = await requireUser("seller");
  const db = await getDb();
  const rows = await db
    .select({
      offerId: offers.id,
      requestId: offers.requestId,
      requestTitle: requests.title,
      requestStatus: requests.status,
      deadline: requests.deadline,
      buyerName: users.name,
      productId: offers.productId,
      productTitle: products.title,
      status: offers.status,
      version: offers.version,
      unitPriceCents: offers.unitPriceCents,
      quantity: offers.quantity,
      shippingCents: offers.shippingCents,
      totalCents: offers.totalCents,
      etaDays: offers.etaDays,
      budgetMaxCents: requests.budgetMaxCents,
      updatedAt: offers.updatedAt,
    })
    .from(offers)
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .innerJoin(users, eq(users.id, requests.buyerId))
    .leftJoin(products, eq(products.id, offers.productId))
    .where(eq(offers.sellerId, user.id))
    .orderBy(desc(offers.updatedAt));

  const requestIds = [...new Set(rows.map((r) => r.requestId))];
  const competing = new Map<string, number>();
  if (requestIds.length) {
    const others = await db
      .select({ requestId: offers.requestId })
      .from(offers)
      .where(and(inArray(offers.requestId, requestIds), ne(offers.sellerId, user.id), ne(offers.status, "withdrawn")));
    for (const o of others) competing.set(o.requestId, (competing.get(o.requestId) ?? 0) + 1);
  }
  const deals = rows.map((r) => ({ ...r, competingOffers: competing.get(r.requestId) ?? 0 }));
  return json({ deals });
});
