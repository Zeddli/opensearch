// Payments service (PAYMENTS). All money-moving goes through here, behind the policy engine.
//
// Flows
//  - vault (agent auto-pay, buyer not present): policy 'auto' + linked vault → order with
//    payment_source.paypal.vault_id → capture → paid.
//  - popup (buyer present): payForOffer returns needs_popup; the frontend's PayPal button
//    calls POST /api/paypal/orders (createPopupOrder) and then .../capture (capturePopupOrder).
// Payments run on PayPal (sandbox) only. Without PayPal credentials payments are disabled
// (routes 503, payForOffer denied). A seller without a PayPal merchant id can never be paid.
// On every successful payment: finalizePaid() → order paid, spent_this_month += amount,
// onOrderPaid(orderId), createShopifyOrder(orderId) (errors caught + logged).
import { and, eq, ne, sql } from "drizzle-orm";
import type { ReceiptCard } from "@/src/agents/protocol";
import { onOrderPaid } from "@/src/agents/hooks";
import {
  agentEvents,
  approvals,
  buyerProfiles,
  getDb,
  offers,
  orders,
  sellerProfiles,
  type Offer,
  type Order,
} from "@/src/db";
import { createShopifyOrder } from "@/src/integrations/shopify";
import {
  capturePayPalOrder,
  createOrderWithFallbacks,
  firstCapture,
  getPayPalOrder,
  isPayPalConfigured,
  PAYPAL_NOT_CONFIGURED,
  PayPalError,
  requirePayPal,
  summarizeOrder,
  valueToCents,
  vaultFromOrder,
  type PayPalOrder,
} from "@/src/integrations/paypal";
import { HttpError } from "@/src/lib/http";
import { buyerHasAutoPay, checkPayment, platformFeeCents, type PaymentDecision } from "@/src/policy";

export type PayForOfferResult =
  | { result: "paid"; orderId: string; receipt: ReceiptCard }
  | { result: "needs_popup"; paypalOrderId?: string }
  | { result: "denied"; reason: string };

// ---------------------------------------------------------------- small helpers

async function logEvent(e: { requestId: string | null; tool: string; input: unknown; output: unknown; decision?: string }) {
  try {
    const db = await getDb();
    await db.insert(agentEvents).values({ requestId: e.requestId, actor: "payments", tool: e.tool, input: e.input, output: e.output, decision: e.decision ?? null });
  } catch (err) {
    console.warn("[payments] could not log agent event", err);
  }
}

async function loadOffer(offerId: string): Promise<Offer> {
  const db = await getDb();
  const [offer] = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  if (!offer) throw new HttpError(404, "Offer not found");
  return offer;
}

async function loadSeller(sellerId: string) {
  const db = await getDb();
  const [seller] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, sellerId)).limit(1);
  return seller ?? null;
}

async function getOrderByOffer(offerId: string): Promise<Order | null> {
  const db = await getDb();
  const [o] = await db.select().from(orders).where(eq(orders.offerId, offerId)).limit(1);
  return o ?? null;
}

async function recordApproval(offerId: string, buyerId: string, amountCents: number) {
  const db = await getDb();
  await db.insert(approvals).values({ offerId, buyerId, amountCents });
}

/** Create or refresh the (single) order row for an offer. Never touches a paid row. */
async function upsertOrderRow(p: {
  offer: Offer;
  buyerId: string;
  amountCents: number;
  platformFeeCents: number;
  mode: Order["mode"];
  paypalOrderId: string | null;
}): Promise<Order> {
  const db = await getDb();
  const values = {
    offerId: p.offer.id,
    requestId: p.offer.requestId,
    buyerId: p.buyerId,
    sellerId: p.offer.sellerId,
    amountCents: p.amountCents,
    platformFeeCents: p.platformFeeCents,
    mode: p.mode,
    paypalOrderId: p.paypalOrderId,
    status: "created" as const,
  };
  const [row] = await db
    .insert(orders)
    .values(values)
    .onConflictDoUpdate({
      target: orders.offerId,
      set: {
        amountCents: values.amountCents,
        platformFeeCents: values.platformFeeCents,
        mode: values.mode,
        paypalOrderId: values.paypalOrderId,
        paypalCaptureId: null,
        status: "created",
      },
      setWhere: ne(orders.status, "paid"),
    })
    .returning();
  if (row) return row;
  const existing = await getOrderByOffer(p.offer.id);
  if (!existing) throw new Error("order upsert failed");
  return existing;
}

/** Build the receipt card for an order. */
export async function buildReceipt(orderId: string): Promise<ReceiptCard> {
  const db = await getDb();
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) throw new HttpError(404, "Order not found");
  const seller = await loadSeller(o.sellerId);
  return {
    type: "receipt",
    orderId: o.id,
    amountCents: o.amountCents,
    platformFeeCents: o.platformFeeCents,
    sellerName: seller?.displayName ?? "Seller",
    paypalOrderId: o.paypalOrderId,
    mode: o.mode,
  };
}

/**
 * Mark an order paid exactly once (safe to call from capture + webhook concurrently),
 * then run side effects: spend counter, onOrderPaid, Shopify write-back.
 */
export async function finalizePaid(orderId: string, p: { paypalCaptureId?: string | null; vault?: { vaultId: string | null; customerId: string | null } } = {}): Promise<ReceiptCard> {
  const db = await getDb();
  const [updated] = await db
    .update(orders)
    .set({ status: "paid", ...(p.paypalCaptureId ? { paypalCaptureId: p.paypalCaptureId } : {}) })
    .where(and(eq(orders.id, orderId), ne(orders.status, "paid")))
    .returning();

  if (updated) {
    await db
      .update(buyerProfiles)
      .set({ spentThisMonthCents: sql`${buyerProfiles.spentThisMonthCents} + ${updated.amountCents}` })
      .where(eq(buyerProfiles.userId, updated.buyerId));

    // Popup payments may have saved the buyer's wallet (store_in_vault ON_SUCCESS).
    if (p.vault?.vaultId) {
      await db
        .update(buyerProfiles)
        .set({ paypalVaultId: p.vault.vaultId, ...(p.vault.customerId ? { paypalCustomerId: p.vault.customerId } : {}) })
        .where(eq(buyerProfiles.userId, updated.buyerId));
    }

    await logEvent({
      requestId: updated.requestId,
      tool: "payment_captured",
      input: { orderId, offerId: updated.offerId, mode: updated.mode },
      output: { amountCents: updated.amountCents, platformFeeCents: updated.platformFeeCents, paypalOrderId: updated.paypalOrderId, paypalCaptureId: updated.paypalCaptureId },
      decision: "paid",
    });

    try {
      await onOrderPaid(orderId);
    } catch (err) {
      console.error("[payments] onOrderPaid failed", orderId, err);
    }
    try {
      const shopifyOrderId = await createShopifyOrder(orderId);
      if (shopifyOrderId) await db.update(orders).set({ shopifyOrderId }).where(eq(orders.id, orderId));
    } catch (err) {
      console.error("[payments] createShopifyOrder failed", orderId, err);
    }
  }
  return buildReceipt(orderId);
}

async function markFailed(orderId: string, reason: string) {
  const db = await getDb();
  const [o] = await db.update(orders).set({ status: "failed" }).where(and(eq(orders.id, orderId), ne(orders.status, "paid"))).returning();
  if (o) await logEvent({ requestId: o.requestId, tool: "payment_failed", input: { orderId }, output: { reason }, decision: "failed" });
}

function feeFor(seller: { platformFeeEnabled: boolean } | null, amountCents: number) {
  return platformFeeCents(amountCents, Boolean(seller?.platformFeeEnabled));
}

/** Validate a captured PayPal order against our order row; finalize if COMPLETED. */
async function settleFromPayPal(row: Order, ppOrder: PayPalOrder): Promise<{ paid: boolean; receipt?: ReceiptCard; reason?: string }> {
  const cap = firstCapture(ppOrder);
  const summary = summarizeOrder(ppOrder);
  if (summary.referenceId && summary.referenceId !== row.offerId) {
    await markFailed(row.id, "reference_id mismatch");
    return { paid: false, reason: "PayPal order does not match this offer" };
  }
  if (cap?.status === "COMPLETED" || (ppOrder.status === "COMPLETED" && !cap)) {
    const captured = valueToCents(cap?.amount?.value);
    if (cap && captured !== row.amountCents) {
      console.error(`[payments] captured amount ${captured} != expected ${row.amountCents} for order ${row.id}`);
    }
    const receipt = await finalizePaid(row.id, { paypalCaptureId: cap?.id ?? null, vault: vaultFromOrder(ppOrder) });
    return { paid: true, receipt };
  }
  if (cap?.status === "PENDING") return { paid: false, reason: "PayPal capture is pending; it will complete via webhook" };
  await markFailed(row.id, `capture status ${cap?.status ?? ppOrder.status}`);
  return { paid: false, reason: `PayPal payment not completed (${cap?.status ?? ppOrder.status})` };
}

// ---------------------------------------------------------------- payForOffer

export async function payForOffer(p: { offerId: string; buyerId: string; userApproved: boolean }): Promise<PayForOfferResult> {
  // Idempotency: one order per offer; a paid offer just returns its receipt.
  const existing = await getOrderByOffer(p.offerId);
  if (existing?.status === "paid") {
    if (existing.buyerId !== p.buyerId) return { result: "denied", reason: "Offer does not belong to one of your requests" };
    return { result: "paid", orderId: existing.id, receipt: await buildReceipt(existing.id) };
  }
  if (!isPayPalConfigured()) return { result: "denied", reason: PAYPAL_NOT_CONFIGURED };

  const decision = await checkPayment({ offerId: p.offerId, buyerId: p.buyerId });
  const offer = decision.allow === "deny" ? null : await loadOffer(p.offerId);
  await logEvent({
    requestId: offer?.requestId ?? null,
    tool: "check_payment",
    input: { offerId: p.offerId, userApproved: p.userApproved },
    output: decision,
    decision: decision.allow,
  });
  if (decision.allow === "deny" || !offer) return { result: "denied", reason: decision.reason };

  if (p.userApproved) await recordApproval(p.offerId, p.buyerId, decision.amountCents);

  if (decision.allow === "needs_approval") {
    // Outside agent limits: the buyer must confirm in the PayPal popup, never a silent charge.
    if (!p.userApproved) return { result: "denied", reason: `Needs your approval: ${decision.reason}` };
    return { result: "needs_popup" };
  }

  // decision.allow === 'auto' → buyer has a saved PayPal wallet and is within limits.
  const db = await getDb();
  const [buyer] = await db.select().from(buyerProfiles).where(eq(buyerProfiles.userId, p.buyerId)).limit(1);
  const seller = await loadSeller(offer.sellerId);
  const vaultId = buyer && buyerHasAutoPay(buyer) ? buyer.paypalVaultId : null;
  if (!vaultId) return { result: "needs_popup" };
  return chargeVault({ offer, buyerId: p.buyerId, vaultId, decision, seller });
}

async function chargeVault(p: {
  offer: Offer;
  buyerId: string;
  vaultId: string;
  decision: PaymentDecision;
  seller: Awaited<ReturnType<typeof loadSeller>>;
}): Promise<PayForOfferResult> {
  const fee = feeFor(p.seller, p.decision.amountCents);
  let row = await upsertOrderRow({ offer: p.offer, buyerId: p.buyerId, amountCents: p.decision.amountCents, platformFeeCents: fee, mode: "vault", paypalOrderId: null });
  try {
    const { order: created, platformFeeCents: appliedFee } = await createOrderWithFallbacks({
      offerId: p.offer.id,
      amountCents: p.decision.amountCents,
      payeeMerchantId: p.seller?.paypalMerchantId ?? null,
      platformFeeCents: fee,
      description: `OpenQuote offer ${p.offer.id}`,
      vaultId: p.vaultId,
      requestId: `vault-${p.offer.id}-${p.decision.amountCents}`,
    });
    const db = await getDb();
    [row] = await db.update(orders).set({ paypalOrderId: created.id, platformFeeCents: appliedFee }).where(eq(orders.id, row.id)).returning();
    if (appliedFee !== fee) console.warn(`[payments] platform fee dropped for order ${row.id} (PayPal rejected it); recorded 0`);

    let ppOrder = created;
    if (ppOrder.status === "PAYER_ACTION_REQUIRED") {
      await markFailed(row.id, "vault requires payer action");
      return { result: "needs_popup" };
    }
    if (ppOrder.status !== "COMPLETED") ppOrder = await capturePayPalOrder(created.id);
    const settled = await settleFromPayPal(row, ppOrder);
    if (settled.paid && settled.receipt) return { result: "paid", orderId: row.id, receipt: settled.receipt };
    return { result: "denied", reason: settled.reason ?? "PayPal payment failed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[payments] vault charge failed; falling back to popup:", msg);
    await markFailed(row.id, msg);
    // Vault blocked (e.g. sandbox doesn't allow PLATFORM vault) → buyer approves in the popup instead.
    if (err instanceof PayPalError && err.status < 500) return { result: "needs_popup" };
    return { result: "denied", reason: "PayPal is unavailable right now; please try again" };
  }
}

// ---------------------------------------------------------------- popup flow (buyer present)

async function assertPayable(offerId: string, buyerId: string): Promise<{ offer: Offer; decision: PaymentDecision }> {
  const existing = await getOrderByOffer(offerId);
  if (existing?.status === "paid") throw new HttpError(409, "This offer has already been paid");
  const decision = await checkPayment({ offerId, buyerId });
  if (decision.allow === "deny") throw new HttpError(400, decision.reason);
  const offer = await loadOffer(offerId);
  return { offer, decision };
}

/** POST /api/paypal/orders — create the PayPal order for the JS SDK button. 503 when PayPal isn't configured. */
export async function createPopupOrder(p: { offerId: string; buyerId: string }): Promise<{ id: string }> {
  requirePayPal();
  const { offer, decision } = await assertPayable(p.offerId, p.buyerId);

  // Reuse a still-open PayPal order for this offer (buyer re-opened the popup).
  const existing = await getOrderByOffer(p.offerId);
  if (existing?.paypalOrderId && existing.mode === "popup" && existing.status === "created" && existing.amountCents === decision.amountCents) {
    try {
      const o = await getPayPalOrder(existing.paypalOrderId);
      if (["CREATED", "APPROVED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(o.status)) return { id: o.id };
    } catch {
      /* create a fresh one */
    }
  }

  const db = await getDb();
  const [buyer] = await db.select().from(buyerProfiles).where(eq(buyerProfiles.userId, p.buyerId)).limit(1);
  const seller = await loadSeller(offer.sellerId);
  const fee = feeFor(seller, decision.amountCents);
  const storeInVault = !buyerHasAutoPay(buyer);
  const { order, platformFeeCents: appliedFee } = await createOrderWithFallbacks({
    offerId: offer.id,
    amountCents: decision.amountCents,
    payeeMerchantId: seller?.paypalMerchantId ?? null,
    platformFeeCents: fee,
    description: `OpenQuote offer ${offer.id}`,
    storeInVault: storeInVault && process.env.PAYPAL_VAULT_ON_POPUP !== "0",
    requestId: `popup-${offer.id}-${crypto.randomUUID()}`,
  });
  await upsertOrderRow({ offer, buyerId: p.buyerId, amountCents: decision.amountCents, platformFeeCents: appliedFee, mode: "popup", paypalOrderId: order.id });
  if (decision.allow === "needs_approval") await recordApproval(offer.id, p.buyerId, decision.amountCents);
  return { id: order.id };
}

/** POST /api/paypal/orders/:id/capture — capture after the buyer approved in the popup. */
export async function capturePopupOrder(p: { paypalOrderId: string; offerId: string; buyerId: string }): Promise<{ orderId: string; receipt: ReceiptCard }> {
  requirePayPal();
  const row = await getOrderByOffer(p.offerId);
  if (!row || row.paypalOrderId !== p.paypalOrderId) throw new HttpError(404, "No pending order for this offer and PayPal order id");
  if (row.buyerId !== p.buyerId) throw new HttpError(403, "Not your order");
  if (row.status === "paid") return { orderId: row.id, receipt: await buildReceipt(row.id) };

  const ppOrder = await capturePayPalOrder(p.paypalOrderId);
  const settled = await settleFromPayPal(row, ppOrder);
  if (!settled.paid || !settled.receipt) throw new HttpError(402, settled.reason ?? "Payment not completed");
  return { orderId: row.id, receipt: settled.receipt };
}

// ---------------------------------------------------------------- webhooks

/** PAYMENT.CAPTURE.COMPLETED — re-reads the order from PayPal before marking paid. */
export async function handleCaptureCompleted(paypalOrderId: string): Promise<"paid" | "ignored"> {
  const db = await getDb();
  const [row] = await db.select().from(orders).where(eq(orders.paypalOrderId, paypalOrderId)).limit(1);
  if (!row) return "ignored";
  if (row.status === "paid") return "paid";
  const ppOrder = await getPayPalOrder(paypalOrderId);
  const settled = await settleFromPayPal(row, ppOrder);
  return settled.paid ? "paid" : "ignored";
}

/** PAYMENT.CAPTURE.DENIED */
export async function handleCaptureDenied(paypalOrderId: string): Promise<"failed" | "ignored"> {
  const db = await getDb();
  const [row] = await db.select().from(orders).where(eq(orders.paypalOrderId, paypalOrderId)).limit(1);
  if (!row || row.status === "paid") return "ignored";
  await markFailed(row.id, "PAYMENT.CAPTURE.DENIED webhook");
  return "failed";
}

// ---------------------------------------------------------------- read helpers (for AGENTS / FRONTEND)

/**
 * Order status for the buyer agent. Accepts our order id or a PayPal order id.
 * Live + PayPal id → fresh status from PayPal Orders v2; otherwise the DB row.
 */
export async function getOrderStatus(idOrPaypalOrderId: string): Promise<{
  orderId: string | null;
  status: Order["status"] | "unknown";
  mode: Order["mode"] | null;
  amountCents: number;
  paypalOrderId: string | null;
  paypal: ReturnType<typeof summarizeOrder> | null;
}> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(orders)
    .where(sql`${orders.id} = ${idOrPaypalOrderId} OR ${orders.paypalOrderId} = ${idOrPaypalOrderId}`)
    .limit(1);
  let paypal: ReturnType<typeof summarizeOrder> | null = null;
  const ppId = row?.paypalOrderId ?? (row ? null : idOrPaypalOrderId);
  if (isPayPalConfigured() && ppId) {
    try {
      paypal = summarizeOrder(await getPayPalOrder(ppId));
    } catch (err) {
      console.warn("[payments] getOrderStatus PayPal lookup failed:", (err as Error).message);
    }
  }
  return {
    orderId: row?.id ?? null,
    status: row?.status ?? "unknown",
    mode: row?.mode ?? null,
    amountCents: row?.amountCents ?? paypal?.amountCents ?? 0,
    paypalOrderId: row?.paypalOrderId ?? paypal?.paypalOrderId ?? null,
    paypal,
  };
}

