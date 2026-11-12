// Cross-module hooks (CONTRACTS §6) — owned by AGENTS. Signatures are fixed.
import { and, eq, ne } from "drizzle-orm";
import { getDb, offers, orders, products, requests, sellerProfiles, users } from "@/src/db";
import { enqueue } from "@/src/jobs/runner";
import type { ReceiptCard } from "@/src/agents/protocol";
import { addMessage, createPost, logEvent, notifySeller, randInt, unitUsd, usd } from "@/src/agents/util";

/** Marks offers won/lost, request paid, posts forum + chat messages (receipt card) for buyer and seller. */
export async function onOrderPaid(orderId: string): Promise<void> {
  const db = await getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.status !== "paid") {
    console.warn("[hooks] onOrderPaid: order missing or not paid", orderId);
    return;
  }
  const [offer] = await db.select().from(offers).where(eq(offers.id, order.offerId)).limit(1);
  const [req] = await db.select().from(requests).where(eq(requests.id, order.requestId)).limit(1);
  if (!offer || !req) return;
  if (offer.status === "won" && req.status === "closed") return; // idempotent

  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, offer.sellerId)).limit(1);
  const [sellerUser] = await db.select({ name: users.name }).from(users).where(eq(users.id, offer.sellerId)).limit(1);
  const sellerName = profile?.displayName ?? sellerUser?.name ?? "Seller";
  const [product] = await db.select().from(products).where(eq(products.id, offer.productId)).limit(1);

  await db.update(offers).set({ status: "won" }).where(eq(offers.id, offer.id));
  const losers = await db
    .update(offers)
    .set({ status: "lost" })
    .where(and(eq(offers.requestId, req.id), ne(offers.id, offer.id), ne(offers.status, "withdrawn")))
    .returning();
  await db.update(requests).set({ status: "paid" }).where(eq(requests.id, req.id));
  if (product) {
    await db.update(products).set({ stock: Math.max(0, product.stock - offer.quantity) }).where(eq(products.id, product.id));
  }

  await createPost({
    requestId: req.id,
    authorKind: "system",
    type: "system",
    body: `✅ Deal closed: ${sellerName} won — ${offer.quantity} × ${product?.title ?? "item"} for ${usd(order.amountCents)}, paid via PayPal. Other offers were not selected. Thanks, everyone!`,
  });
  await createPost({
    requestId: req.id,
    authorKind: "seller_agent",
    authorId: offer.sellerId,
    type: "system",
    offerId: offer.id,
    body: `Payment received — thank you! ${sellerName} is starting production; ${offer.quantity} units will arrive in ${offer.etaDays} days.`,
  });

  const receipt: ReceiptCard = {
    type: "receipt",
    orderId: order.id,
    amountCents: order.amountCents,
    platformFeeCents: order.platformFeeCents,
    sellerName,
    paypalOrderId: order.paypalOrderId,
    mode: order.mode,
  };
  await addMessage(
    req.sessionId,
    "assistant",
    `Paid ${usd(order.amountCents)} to ${sellerName} via PayPal — the money went straight to the seller. Expect delivery in ${offer.etaDays} days. 🎉`,
    receipt,
  );
  await db.update(requests).set({ status: "closed" }).where(eq(requests.id, req.id));

  await notifySeller(
    offer.sellerId,
    `💰 Sold! ${offer.quantity} × ${product?.title ?? "item"} at ${unitUsd(offer.unitPriceCents)}/unit — ${usd(order.amountCents - order.platformFeeCents)} received in PayPal${order.platformFeeCents ? ` (after ${usd(order.platformFeeCents)} platform fee)` : ""} for “${req.title}”.`,
    "success",
  );
  for (const l of losers) {
    await notifySeller(l.sellerId, `Your offer on “${req.title}” wasn't selected — the buyer chose another seller.`, "info");
  }
  await logEvent({
    requestId: req.id,
    actor: "system",
    tool: "order_paid",
    input: { orderId },
    output: { winner: offer.id, losers: losers.map((l) => l.id) },
    decision: "closed",
  });
}

/** Enqueue seller agents + analysis for a newly posted request. */
export async function onRequestPosted(requestId: string): Promise<void> {
  const db = await getDb();
  const [req] = await db.select().from(requests).where(eq(requests.id, requestId)).limit(1);
  if (!req || req.status !== "open") return;
  const windowMs = Math.max(5000, (req.windowEndsAt?.getTime() ?? Date.now() + 45_000) - Date.now());

  const sellers = await db
    .selectDistinct({ id: sellerProfiles.userId })
    .from(sellerProfiles)
    .innerJoin(products, and(eq(products.sellerId, sellerProfiles.userId), eq(products.active, true)))
    .where(eq(sellerProfiles.autoDeal, true));
  // Seller agents reply within 2–15s (scaled down for short windows so they land before it closes).
  const maxDelay = Math.min(15_000, Math.max(2500, Math.floor(windowMs * 0.45)));
  for (const s of sellers) {
    if (s.id === req.buyerId) continue;
    enqueue("seller.consider", { requestId, sellerId: s.id }, { delayMs: randInt(Math.min(2000, maxDelay - 500), maxDelay) });
  }
  enqueue("buyer.analyze", { requestId, phase: "initial" }, { delayMs: windowMs });
  await logEvent({
    requestId,
    actor: "system",
    tool: "request_posted",
    input: { requestId },
    output: { sellers: sellers.length, windowMs },
    decision: "enqueued seller.consider + buyer.analyze",
  });
}
