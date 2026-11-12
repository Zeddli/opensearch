// Deterministic agent steps that replaced LLM calls (seller matching, buyer counters, re-scoring,
// answers to seller questions, the seller's "how are my deals?" question).
import { describe, expect, it } from "vitest";
import type { Offer, Product } from "@/src/db";
import type { RequestSpec } from "@/src/agents/protocol";
import { candidateProducts } from "@/src/agents/seller/match";
import { offerQuantity } from "@/src/agents/seller/agent";
import { isDealsQuestion } from "@/src/agents/seller/chat";
import { NOT_ASSESSED, planCounters, storedAssessment } from "@/src/agents/buyer/score";
import { specAnswer } from "@/src/agents/buyer/analyze";

const product = (over: Partial<Product> = {}): Product => ({
  id: "p1",
  sellerId: "s1",
  source: "chat",
  title: "12oz compostable paper cups",
  description: "Custom-printed hot cups",
  category: "cups",
  unitPriceCents: 30,
  stock: 5000,
  moq: 500,
  leadTimeDays: 5,
  attributes: {},
  floorPriceCents: 25,
  maxDiscountPct: 15,
  maxQtyPerOrder: null,
  shopifyProductId: null,
  shopifyVariantId: null,
  imageUrl: null,
  active: true,
  createdAt: new Date(),
  ...over,
} as Product);

const spec = (over: Partial<RequestSpec> = {}): RequestSpec => ({
  item: "12oz compostable cups",
  category: "cups",
  quantity: 1000,
  budgetMaxCents: 40000,
  deadline: "2026-12-01",
  location: "Austin, TX",
  mustHave: ["compostable"],
  niceToHave: ["custom print"],
  ...over,
});

describe("seller pre-filter (no LLM call for irrelevant catalogs)", () => {
  it("keeps products sharing keywords or the category, best first", () => {
    const cups = product();
    const lids = product({ id: "p2", title: "Coffee cup lids", category: "packaging", description: "" });
    const chairs = product({ id: "p3", title: "Oak dining chair", category: "furniture", description: "Solid wood" });
    const out = candidateProducts(spec(), [chairs, lids, cups]);
    expect(out.map((c) => c.product.id)).toEqual(["p1", "p2"]);
    expect(candidateProducts(spec(), [chairs])).toEqual([]);
  });

  it("matches on the normalised category even without shared words", () => {
    const tumblers = product({ id: "p4", title: "Paper tumblers", description: "", category: "cups" });
    expect(candidateProducts(spec({ item: "hot drink vessels", mustHave: [] }), [tumblers]).map((c) => c.product.id)).toEqual(["p4"]);
  });

  it("offerQuantity respects stock, per-order cap and MOQ", () => {
    expect(offerQuantity(product(), 1000)).toBe(1000);
    expect(offerQuantity(product({ stock: 800 }), 1000)).toBe(800);
    expect(offerQuantity(product({ maxQtyPerOrder: 600 }), 1000)).toBe(600);
    expect(offerQuantity(product({ moq: 500 }), 400)).toBe(500); // bumped up to a nearby MOQ
    expect(offerQuantity(product({ moq: 5000 }), 100)).toBeNull();
    expect(offerQuantity(product({ stock: 100, moq: 500 }), 1000)).toBeNull();
  });
});

const offer = (id: string, unit: number, qty = 1000, shipping = 0): Pick<Offer, "id" | "unitPriceCents" | "quantity" | "shippingCents" | "totalCents"> => ({
  id,
  unitPriceCents: unit,
  quantity: qty,
  shippingCents: shipping,
  totalCents: unit * qty + shipping,
});

describe("buyer counters (deterministic)", () => {
  it("counters at most two offers, ~8% off or a cheaper rival's price, never more than 15% off", () => {
    const plan = planCounters([{ offer: offer("a", 30) }, { offer: offer("b", 32) }, { offer: offer("c", 35) }], 0);
    expect(plan.map((p) => p.offerId)).toEqual(["a", "b"]);
    expect(plan[0].targetUnitPriceCents).toBe(28); // 30 × 0.92 = 27.6 → 28
    expect(plan[1].targetUnitPriceCents).toBe(30); // matches the cheaper rival
    for (const p of plan) expect(p.message).toMatch(/Could you do \$0\.\d\d\/unit/);
  });

  it("asks for less when that keeps the total within budget, bounded at 15% off", () => {
    const [p] = planCounters([{ offer: offer("a", 100, 100, 500) }], 9500); // total $105, budget $95
    expect(p.targetUnitPriceCents).toBe(90); // (9500 − 500) / 100
    const [q] = planCounters([{ offer: offer("a", 100, 100) }], 5000); // budget way below → capped at 15% off
    expect(q.targetUnitPriceCents).toBe(85);
  });

  it("never reveals the budget or competitors in the message", () => {
    const [p] = planCounters([{ offer: offer("a", 100, 100) }, { offer: offer("b", 90, 100) }], 9000);
    expect(p.message).not.toMatch(/budget|competitor|other seller|\$90\.00/i);
  });

  it("skips offers too cheap to counter", () => {
    expect(planCounters([{ offer: offer("a", 1) }], 0)).toEqual([]);
  });
});

describe("re-scoring reuses the stored LLM assessment", () => {
  it("splits the stored rationale and keeps only LLM flags", () => {
    const a = storedAssessment({
      id: "o1",
      specMatch: 80,
      flags: ["no return policy", "no warranty", "ETA 9d after deadline (5d left)"],
      rationale: "Good fit for the spec. ⚠️ no return policy; no warranty; ETA 9d after deadline (5d left)",
    });
    expect(a).toEqual({ offerId: "o1", specMatch: 0.8, extraFlags: ["no warranty"], rationale: "Good fit for the spec." });
  });

  it("asks the LLM again for offers that were never assessed", () => {
    expect(storedAssessment({ id: "o1", specMatch: null, flags: [], rationale: null })).toBeNull();
    expect(storedAssessment({ id: "o1", specMatch: 50, flags: [], rationale: `${NOT_ASSESSED} ⚠️ x` })).toBeNull();
  });
});

describe("answers without an LLM call", () => {
  it("answers seller questions from the spec, never the budget", () => {
    const a = specAnswer(spec({ unit: "pcs" }));
    expect(a).toContain("1000 pcs × 12oz compostable cups");
    expect(a).toContain("Austin, TX");
    expect(a).toContain("must have: compostable");
    expect(a).not.toMatch(/400|budget/i);
  });

  it("recognises short deals questions but not product descriptions", () => {
    for (const t of ["How are my deals going?", "any sales?", "deal status", "show my offers"]) expect(isDealsQuestion(t), t).toBe(true);
    for (const t of ["I sell 12oz cups at $0.30, 5000 in stock", "hello", "I sell premium coffee deals for cafes and offices with fast delivery and custom printing included"]) {
      expect(isDealsQuestion(t), t).toBe(false);
    }
  });
});
