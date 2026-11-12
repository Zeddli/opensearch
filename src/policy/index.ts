// Policy engine (PAYMENTS). Pure decision functions + thin DB loaders.
//  - checkOffer: seller guardrails (floor price, max discount, stock, per-order cap)
//  - checkPayment: buyer spend policy (ownership, amount integrity, seller readiness, limits)
import { and, eq } from "drizzle-orm";
import {
  buyerProfiles,
  getDb,
  offers,
  orders,
  requests,
  sellerProfiles,
  type BuyerProfile,
  type Offer,
  type Product,
  type RequestRow,
  type SellerProfile,
} from "@/src/db";
import { env } from "@/src/lib/env";

// ---------------------------------------------------------------- helpers (pure)

/** Lowest unit price a seller agent may offer: max(floor, list × (1 − maxDiscount%)). */
export function minAllowedUnitPriceCents(product: Pick<Product, "unitPriceCents" | "floorPriceCents" | "maxDiscountPct">): number {
  const pct = Math.min(100, Math.max(0, product.maxDiscountPct ?? 0));
  const byDiscount = Math.ceil((product.unitPriceCents * (100 - pct)) / 100);
  return Math.max(product.floorPriceCents, byDiscount);
}

/** Server-side offer total: unit × qty + shipping. */
export function computeOfferTotalCents(o: Pick<Offer, "unitPriceCents" | "quantity" | "shippingCents">): number {
  return o.unitPriceCents * o.quantity + (o.shippingCents ?? 0);
}

/** Platform fee in cents (basis points, rounded half-up). 0 when the seller hasn't enabled fees. */
export function platformFeeCents(amountCents: number, enabled: boolean, bps: number = env.PLATFORM_FEE_BPS): number {
  if (!enabled || bps <= 0 || amountCents <= 0) return 0;
  return Math.min(amountCents, Math.round((amountCents * bps) / 10000));
}

// ---------------------------------------------------------------- checkOffer (pure)

export function checkOffer(p: { product: Product; unitPriceCents: number; quantity: number }): {
  allow: boolean;
  reason?: string;
  clampedUnitPriceCents: number;
} {
  const { product } = p;
  const minPrice = minAllowedUnitPriceCents(product);
  const asked = Math.round(p.unitPriceCents);
  const clampedUnitPriceCents = Math.max(asked, minPrice);
  const qty = p.quantity;

  if (!product.active) return { allow: false, reason: "Product is not active", clampedUnitPriceCents };
  if (!Number.isInteger(qty) || qty <= 0) return { allow: false, reason: "Quantity must be a positive integer", clampedUnitPriceCents };
  if (qty > product.stock) {
    return { allow: false, reason: `Insufficient stock (${product.stock} available, ${qty} requested)`, clampedUnitPriceCents };
  }
  if (product.maxQtyPerOrder != null && qty > product.maxQtyPerOrder) {
    return { allow: false, reason: `Exceeds max quantity per order (${product.maxQtyPerOrder})`, clampedUnitPriceCents };
  }
  if (clampedUnitPriceCents !== asked) {
    const why = minPrice === product.floorPriceCents ? "floor price" : `max discount ${product.maxDiscountPct}% off list`;
    return { allow: true, reason: `Price raised to ${clampedUnitPriceCents}¢ (${why})`, clampedUnitPriceCents };
  }
  return { allow: true, clampedUnitPriceCents };
}

// ---------------------------------------------------------------- checkPayment

export type PaymentDecision = { allow: "auto" | "needs_approval" | "deny"; reason: string; amountCents: number };

export const PAYABLE_REQUEST_STATUSES: ReadonlyArray<RequestRow["status"]> = ["open", "analyzing", "recommended", "approved"];
export const PAYABLE_OFFER_STATUSES: ReadonlyArray<Offer["status"]> = ["active", "countered", "revised", "won"];

export type PaymentFacts = {
  buyerId: string;
  offer: Pick<Offer, "id" | "status" | "unitPriceCents" | "quantity" | "shippingCents" | "totalCents"> | null;
  request: Pick<RequestRow, "buyerId" | "status"> | null;
  buyer: Pick<BuyerProfile, "autoPayLimitCents" | "monthlyCapCents" | "spentThisMonthCents" | "paypalVaultId"> | null;
  seller: Pick<SellerProfile, "paypalMerchantId"> | null;
  alreadyPaid: boolean;
};

/** Why a seller can't be paid yet, shown to buyers and agents. */
export const SELLER_CANT_RECEIVE_PAYPAL = "Seller can't receive PayPal yet (no PayPal account connected)";

/**
 * A seller can be paid only with a PayPal merchant id (onboarding or paste-in). Agents flag offers from
 * other sellers with SELLER_CANT_RECEIVE_PAYPAL instead of recommending them as payable.
 */
export function sellerCanReceivePayPal(seller: Pick<SellerProfile, "paypalMerchantId"> | null | undefined): boolean {
  return Boolean(seller?.paypalMerchantId?.trim());
}

/** Whether the buyer saved a PayPal wallet (vault id) the agent can charge. */
export function buyerHasAutoPay(buyer: Pick<BuyerProfile, "paypalVaultId"> | null | undefined): boolean {
  return Boolean(buyer?.paypalVaultId?.trim());
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Pure spend-policy decision. */
export function evaluatePayment(f: PaymentFacts): PaymentDecision {
  const { offer, request, buyer, seller } = f;
  if (!offer) return { allow: "deny", reason: "Offer not found", amountCents: 0 };
  const amountCents = computeOfferTotalCents(offer);
  const deny = (reason: string): PaymentDecision => ({ allow: "deny", reason, amountCents });

  if (!request || request.buyerId !== f.buyerId) return deny("Offer does not belong to one of your requests");
  if (f.alreadyPaid || request.status === "paid") return deny("This request has already been paid");
  if (!PAYABLE_REQUEST_STATUSES.includes(request.status)) return deny(`Request is ${request.status}; it can't be paid`);
  if (!PAYABLE_OFFER_STATUSES.includes(offer.status)) return deny(`Offer is ${offer.status}`);
  if (amountCents <= 0) return deny("Offer total must be positive");
  if (amountCents !== offer.totalCents) {
    return deny(`Offer total mismatch (stored ${usd(offer.totalCents)}, recomputed ${usd(amountCents)})`);
  }
  if (!seller) return deny("Seller not found");
  if (!sellerCanReceivePayPal(seller)) return deny(SELLER_CANT_RECEIVE_PAYPAL);
  if (!buyer) return deny("Buyer profile not found");

  const spentAfter = buyer.spentThisMonthCents + amountCents;
  if (!buyerHasAutoPay(buyer)) {
    return { allow: "needs_approval", reason: "PayPal not linked for agent payments; approve in PayPal", amountCents };
  }
  if (amountCents > buyer.autoPayLimitCents) {
    return { allow: "needs_approval", reason: `${usd(amountCents)} is over your auto-pay limit of ${usd(buyer.autoPayLimitCents)}`, amountCents };
  }
  if (spentAfter > buyer.monthlyCapCents) {
    return {
      allow: "needs_approval",
      reason: `Would exceed your monthly cap (${usd(spentAfter)} of ${usd(buyer.monthlyCapCents)})`,
      amountCents,
    };
  }
  return { allow: "auto", reason: `Within limits (${usd(amountCents)} ≤ ${usd(buyer.autoPayLimitCents)} auto-pay limit)`, amountCents };
}

/** Load facts from the DB and evaluate. */
export async function checkPayment(p: { offerId: string; buyerId: string }): Promise<PaymentDecision> {
  const db = await getDb();
  const [offer] = await db.select().from(offers).where(eq(offers.id, p.offerId)).limit(1);
  if (!offer) return { allow: "deny", reason: "Offer not found", amountCents: 0 };
  const [[request], [buyer], [seller], paid] = await Promise.all([
    db.select().from(requests).where(eq(requests.id, offer.requestId)).limit(1),
    db.select().from(buyerProfiles).where(eq(buyerProfiles.userId, p.buyerId)).limit(1),
    db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, offer.sellerId)).limit(1),
    db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.requestId, offer.requestId), eq(orders.status, "paid")))
      .limit(1),
  ]);
  return evaluatePayment({
    buyerId: p.buyerId,
    offer,
    request: request ?? null,
    buyer: buyer ?? null,
    seller: seller ?? null,
    alreadyPaid: paid.length > 0,
  });
}
