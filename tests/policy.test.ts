import { describe, expect, it } from "vitest";
import type { Product } from "@/src/db";
import {
  checkOffer,
  computeOfferTotalCents,
  evaluatePayment,
  minAllowedUnitPriceCents,
  platformFeeCents,
  buyerHasAutoPay,
  SELLER_CANT_RECEIVE_PAYPAL,
  sellerCanReceivePayPal,
  type PaymentFacts,
} from "@/src/policy";
import { buildOrderBody } from "@/src/integrations/paypal/orders";
import { centsToValue, valueToCents } from "@/src/integrations/paypal/client";

const product = (over: Partial<Product> = {}): Product => ({
  id: "p1",
  sellerId: "s1",
  source: "chat",
  title: "12oz compostable cup",
  description: "",
  category: "packaging",
  unitPriceCents: 100, // $1.00 list
  stock: 1000,
  moq: 1,
  leadTimeDays: 3,
  attributes: {},
  floorPriceCents: 80,
  maxDiscountPct: 15, // → min 85 by discount
  maxQtyPerOrder: null,
  imageUrl: null,
  shopifyProductId: null,
  shopifyVariantId: null,
  active: true,
  createdAt: new Date(),
  ...over,
});

describe("checkOffer", () => {
  it("allows a price at or above the minimum unchanged", () => {
    expect(checkOffer({ product: product(), unitPriceCents: 95, quantity: 10 })).toEqual({ allow: true, clampedUnitPriceCents: 95 });
  });
  it("clamps to the max-discount price when that is above the floor", () => {
    const r = checkOffer({ product: product(), unitPriceCents: 70, quantity: 10 });
    expect(r.allow).toBe(true);
    expect(r.clampedUnitPriceCents).toBe(85);
    expect(r.reason).toMatch(/discount/);
  });
  it("never goes below the floor price", () => {
    const p = product({ floorPriceCents: 90, maxDiscountPct: 50 });
    expect(minAllowedUnitPriceCents(p)).toBe(90);
    const r = checkOffer({ product: p, unitPriceCents: 10, quantity: 1 });
    expect(r.clampedUnitPriceCents).toBe(90);
    expect(r.reason).toMatch(/floor/);
  });
  it("rounds the discount bound up (never under-prices by a cent)", () => {
    expect(minAllowedUnitPriceCents(product({ unitPriceCents: 999, floorPriceCents: 0, maxDiscountPct: 15 }))).toBe(850); // 849.15 → 850
  });
  it("denies quantity over stock", () => {
    const r = checkOffer({ product: product({ stock: 5 }), unitPriceCents: 100, quantity: 6 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/stock/i);
  });
  it("denies quantity over max_qty_per_order", () => {
    const r = checkOffer({ product: product({ maxQtyPerOrder: 50 }), unitPriceCents: 100, quantity: 51 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/max quantity/i);
  });
  it("denies inactive products and non-positive quantity", () => {
    expect(checkOffer({ product: product({ active: false }), unitPriceCents: 100, quantity: 1 }).allow).toBe(false);
    expect(checkOffer({ product: product(), unitPriceCents: 100, quantity: 0 }).allow).toBe(false);
  });
});

describe("money helpers", () => {
  it("computes offer totals and fees", () => {
    expect(computeOfferTotalCents({ unitPriceCents: 36, quantity: 1000, shippingCents: 1500 })).toBe(37500);
    expect(platformFeeCents(36000, true, 300)).toBe(1080);
    expect(platformFeeCents(36000, false, 300)).toBe(0);
    expect(platformFeeCents(333, true, 300)).toBe(10); // 9.99 → 10
  });
  it("formats PayPal amounts without float drift", () => {
    expect(centsToValue(36000)).toBe("360.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(centsToValue(1999)).toBe("19.99");
    expect(valueToCents("19.99")).toBe(1999);
    expect(valueToCents("0.29")).toBe(29);
  });
});

const facts = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({
  buyerId: "b1",
  offer: { id: "o1", status: "active", unitPriceCents: 100, quantity: 100, shippingCents: 500, totalCents: 10500 },
  request: { buyerId: "b1", status: "recommended" },
  buyer: { autoPayLimitCents: 20000, monthlyCapCents: 100000, spentThisMonthCents: 0, paypalVaultId: "VAULT-1" },
  seller: { paypalMerchantId: "MERCHANT-1" },
  alreadyPaid: false,
  ...over,
});

describe("evaluatePayment", () => {
  it("auto-pays within limits with a linked vault", () => {
    expect(evaluatePayment(facts())).toMatchObject({ allow: "auto", amountCents: 10500 });
  });
  it("denies a missing offer", () => {
    expect(evaluatePayment(facts({ offer: null })).allow).toBe("deny");
  });
  it("denies another buyer's request", () => {
    expect(evaluatePayment(facts({ request: { buyerId: "someone-else", status: "recommended" } })).allow).toBe("deny");
  });
  it("denies if the request is already paid", () => {
    expect(evaluatePayment(facts({ alreadyPaid: true })).allow).toBe("deny");
    expect(evaluatePayment(facts({ request: { buyerId: "b1", status: "paid" } })).allow).toBe("deny");
  });
  it("denies closed/draft requests and withdrawn/lost offers", () => {
    expect(evaluatePayment(facts({ request: { buyerId: "b1", status: "closed" } })).allow).toBe("deny");
    expect(evaluatePayment(facts({ request: { buyerId: "b1", status: "draft" } })).allow).toBe("deny");
    const o = facts().offer!;
    expect(evaluatePayment(facts({ offer: { ...o, status: "withdrawn" } })).allow).toBe("deny");
    expect(evaluatePayment(facts({ offer: { ...o, status: "lost" } })).allow).toBe("deny");
  });
  it("denies when the stored total doesn't match the recomputed total", () => {
    const o = facts().offer!;
    const r = evaluatePayment(facts({ offer: { ...o, totalCents: 100 } }));
    expect(r.allow).toBe("deny");
    expect(r.reason).toMatch(/mismatch/);
    expect(r.amountCents).toBe(10500); // always the recomputed amount
  });
  it("always denies when the seller has no PayPal merchant id", () => {
    for (const paypalMerchantId of [null, "", "   "]) {
      const r = evaluatePayment(facts({ seller: { paypalMerchantId } }));
      expect(r.allow).toBe("deny");
      expect(r.reason).toBe(SELLER_CANT_RECEIVE_PAYPAL);
    }
  });
  it("denies a missing seller", () => {
    expect(evaluatePayment(facts({ seller: null })).allow).toBe("deny");
  });
  it("sellerCanReceivePayPal flags sellers without a merchant id", () => {
    expect(sellerCanReceivePayPal({ paypalMerchantId: "MERCHANT1" })).toBe(true);
    expect(sellerCanReceivePayPal({ paypalMerchantId: null })).toBe(false);
    expect(sellerCanReceivePayPal({ paypalMerchantId: "" })).toBe(false);
    expect(sellerCanReceivePayPal({ paypalMerchantId: "   " })).toBe(false);
    expect(sellerCanReceivePayPal(null)).toBe(false);
  });
  it("buyerHasAutoPay requires a saved PayPal vault id", () => {
    expect(buyerHasAutoPay({ paypalVaultId: "VAULT-1" })).toBe(true);
    expect(buyerHasAutoPay({ paypalVaultId: null })).toBe(false);
    expect(buyerHasAutoPay({ paypalVaultId: " " })).toBe(false);
    expect(buyerHasAutoPay(null)).toBe(false);
  });
  it("denies another buyer's offer and an already-paid request", () => {
    expect(evaluatePayment(facts({ request: { buyerId: "other", status: "recommended" } })).allow).toBe("deny");
    expect(evaluatePayment(facts({ alreadyPaid: true })).allow).toBe("deny");
  });
  it("needs approval without a linked vault", () => {
    const b = facts().buyer!;
    expect(evaluatePayment(facts({ buyer: { ...b, paypalVaultId: null } })).allow).toBe("needs_approval");
  });
  it("needs approval over the auto-pay limit (boundary inclusive)", () => {
    const b = facts().buyer!;
    expect(evaluatePayment(facts({ buyer: { ...b, autoPayLimitCents: 10500 } })).allow).toBe("auto");
    expect(evaluatePayment(facts({ buyer: { ...b, autoPayLimitCents: 10499 } })).allow).toBe("needs_approval");
  });
  it("needs approval when the monthly cap would be exceeded (boundary inclusive)", () => {
    const b = facts().buyer!;
    expect(evaluatePayment(facts({ buyer: { ...b, spentThisMonthCents: 89500 } })).allow).toBe("auto");
    expect(evaluatePayment(facts({ buyer: { ...b, spentThisMonthCents: 89501 } })).allow).toBe("needs_approval");
  });
});

describe("buildOrderBody (Multiparty)", () => {
  it("routes to the seller and includes the platform fee only when > 0", () => {
    const body = buildOrderBody({ offerId: "o1", amountCents: 36000, payeeMerchantId: "M1", platformFeeCents: 1080, requestId: "x" }) as {
      intent: string;
      purchase_units: Array<Record<string, any>>;
      payment_source?: unknown;
    };
    expect(body.intent).toBe("CAPTURE");
    const pu = body.purchase_units[0];
    expect(pu.reference_id).toBe("o1");
    expect(pu.amount).toEqual({ currency_code: "USD", value: "360.00" });
    expect(pu.payee).toEqual({ merchant_id: "M1" });
    expect(pu.payment_instruction.platform_fees[0].amount.value).toBe("10.80");
    expect(body.payment_source).toBeUndefined();

    const noFee = buildOrderBody({ offerId: "o1", amountCents: 36000, payeeMerchantId: "M1", platformFeeCents: 0, requestId: "x" }) as {
      purchase_units: Array<Record<string, unknown>>;
    };
    expect(noFee.purchase_units[0].payment_instruction).toBeUndefined();
  });
  it("charges a vault id or asks to save the wallet", () => {
    const v = buildOrderBody({ offerId: "o1", amountCents: 100, payeeMerchantId: "M1", platformFeeCents: 0, vaultId: "V1", requestId: "x" }) as any;
    expect(v.payment_source).toEqual({ paypal: { vault_id: "V1" } });
    const s = buildOrderBody({ offerId: "o1", amountCents: 100, payeeMerchantId: "M1", platformFeeCents: 0, storeInVault: true, requestId: "x" }) as any;
    expect(s.payment_source.paypal.attributes.vault.store_in_vault).toBe("ON_SUCCESS");
  });
});
