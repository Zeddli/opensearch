// Offer scoring (architecture §5.2). The buyer's LLM supplies spec_match / extra flags / rationale (once per
// offer; re-scores reuse it); the final ai_score is ALWAYS computed here in code so it's explainable + stable:
//   score = 0.40·priceScore + 0.25·deadlineFit + 0.20·specMatch + 0.15·sellerTrust − penalties(flags)
// ai_score and spec_match are stored on a 0–100 scale.
import { z } from "zod";
import type { MarketListing, Offer, Product, RequestRow, SellerProfile } from "@/src/db";
import { SELLER_CANT_RECEIVE_PAYPAL, sellerCanReceivePayPal } from "@/src/policy";
import { llmObject, UNTRUSTED_NOTE } from "@/src/agents/llm";
import { clamp, daysUntil, tokens, unitUsd, usd } from "@/src/agents/util";

export type OfferCtx = { offer: Offer; product: Product | null; seller: SellerProfile | null };
export type Scored = { offerId: string; aiScore: number; specMatch: number; flags: string[]; rationale: string };

export const FLAG = {
  suspicious: (pct: number, vs: "market" | "other offers") => `price ${pct}% below ${vs}`,
  noReturns: "no return policy",
  late: (eta: number, days: number) => `ETA ${eta}d after deadline (${days}d left)`,
  qtyShort: (q: number, want: number) => `quantity short (${q}/${want})`,
  payments: SELLER_CANT_RECEIVE_PAYPAL,
  overBudget: (over: number) => `over budget by ${usd(over)}`,
  vague: "vague terms",
};
export const isSuspiciousFlag = (f: string) => /below (?:market|other offers)/.test(f);
const HARD_RISK = /after deadline|vague terms/i;
export const isUnpayableFlag = (f: string) => f === SELLER_CANT_RECEIVE_PAYPAL;
/**
 * 0 = clean, 1 = soft flags only, 2 = hard risk flag, 3 = suspicious price, 4 = seller can't receive PayPal
 * (can't be paid at all, so never the top pick unless nothing else exists). Unknown (LLM) flags count as soft.
 */
export function riskTier(flags: string[]): number {
  if (flags.some(isUnpayableFlag)) return 4;
  if (flags.some(isSuspiciousFlag)) return 3;
  if (flags.some((f) => HARD_RISK.test(f))) return 2;
  return flags.length ? 1 : 0;
}

const PENALTY: Array<[RegExp, number]> = [
  [/below (?:market|other offers)/, 0.35],
  [/no return policy/, 0.08],
  [/after deadline/, 0.15],
  [/quantity short/, 0.12],
  [/can't receive PayPal/, 0.2],
  [/over budget/, 0.12],
  [/vague terms/, 0.05],
];

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** The seller can be paid (has a PayPal merchant id). */
export const paymentsReady = (s: SellerProfile | null) => sellerCanReceivePayPal(s);

/** Listings comparable to the spec (title covers ≥60% of must-haves); falls back to all listings. */
export function comparableListings(req: RequestRow, listings: MarketListing[]): MarketListing[] {
  const must = req.spec.mustHave.map((m) => tokens(m)).filter((t) => t.length);
  if (!must.length || !listings.length) return listings;
  const has = (title: Set<string>, t: string) => title.has(t) || [...title].some((x) => x.length > 4 && t.length > 4 && (x.startsWith(t) || t.startsWith(x)));
  const comp = listings.filter((l) => {
    const title = new Set(tokens(l.title));
    return must.filter((ts) => ts.every((t) => has(title, t))).length / must.length >= 0.6;
  });
  return comp.length ? comp : listings;
}

/** Deterministic rule flags. */
export function ruleFlags(req: RequestRow, c: OfferCtx, marketMedian: number | null, forumMedian: number | null): string[] {
  const o = c.offer;
  const flags: string[] = [];
  if (marketMedian && o.totalCents < marketMedian * 0.5) flags.push(FLAG.suspicious(Math.round((1 - o.totalCents / marketMedian) * 100), "market"));
  else if (forumMedian && o.totalCents < forumMedian * 0.5) flags.push(FLAG.suspicious(Math.round((1 - o.totalCents / forumMedian) * 100), "other offers"));
  if (!o.returnPolicy) flags.push(FLAG.noReturns);
  const days = daysUntil(req.deadline);
  if (o.etaDays > days) flags.push(FLAG.late(o.etaDays, days));
  if (o.quantity < req.spec.quantity) flags.push(FLAG.qtyShort(o.quantity, req.spec.quantity));
  if (!paymentsReady(c.seller)) flags.push(FLAG.payments);
  if (req.budgetMaxCents > 0 && o.totalCents > req.budgetMaxCents) flags.push(FLAG.overBudget(o.totalCents - req.budgetMaxCents));
  if (!o.warranty && /after payment|tbc|to be confirmed|details later/i.test(`${o.terms ?? ""} ${o.pitch}`)) flags.push(FLAG.vague);
  return flags;
}

export function computeScore(req: RequestRow, c: OfferCtx, specMatch01: number, flags: string[], minTotal: number, marketMedian: number | null): number {
  const o = c.offer;
  const p1 = minTotal > 0 ? clamp(minTotal / o.totalCents, 0, 1) : 1;
  const p2 = marketMedian ? clamp(0.5 + (marketMedian - o.totalCents) / (2 * marketMedian), 0, 1) : p1;
  const priceScore = 0.5 * p1 + 0.5 * p2;
  const days = Math.max(1, daysUntil(req.deadline));
  const deadlineFit = o.etaDays <= days ? 1 : clamp(1 - (o.etaDays - days) / days, 0, 1);
  const trust = clamp((c.seller?.rating ?? 4) / 5, 0, 1) * (paymentsReady(c.seller) ? 1 : 0.6);
  const penalties = flags.reduce((acc, f) => acc + (PENALTY.find(([re]) => re.test(f))?.[1] ?? 0.03), 0);
  const score = 0.4 * priceScore + 0.25 * deadlineFit + 0.2 * specMatch01 + 0.15 * trust - penalties;
  return Math.round(clamp(score, 0, 1) * 1000) / 10;
}

const LlmAssessSchema = z.object({
  assessments: z.array(
    z.object({
      offerId: z.string(),
      specMatch: z.number().describe("0..1: how well the PRODUCT meets the buyer's spec"),
      extraFlags: z.array(z.string()).describe("Short risk phrases not already covered by the rule flags; [] if none"),
      rationale: z.string().describe("One sentence for the buyer"),
    }),
  ),
});
type Assessment = z.infer<typeof LlmAssessSchema>["assessments"][number];

export const NOT_ASSESSED = "Not assessed by the AI; scored on price, delivery and seller trust only.";
const FLAG_SEP = " ⚠️ ";
/** Flags produced by ruleFlags (recomputed on every scoring); anything else on an offer came from the LLM. */
const RULE_FLAG = /below (?:market|other offers)|^no return policy$|after deadline|^quantity short|can't receive PayPal|^over budget|^vague terms$/;

/**
 * The LLM assessment already stored on an offer (from an earlier scoring of the same request), or null.
 * Re-scoring after a counter / retry reuses it instead of asking the LLM again: the product and spec
 * are unchanged, only price-dependent rule flags and the formula are recomputed.
 */
export function storedAssessment(o: Pick<Offer, "id" | "specMatch" | "flags" | "rationale">): Assessment | null {
  if (o.specMatch == null || !o.rationale || o.rationale.startsWith(NOT_ASSESSED)) return null;
  const sep = o.rationale.indexOf(FLAG_SEP);
  return {
    offerId: o.id,
    specMatch: clamp(o.specMatch / 100, 0, 1),
    extraFlags: (o.flags ?? []).filter((f) => !RULE_FLAG.test(f)),
    rationale: sep >= 0 ? o.rationale.slice(0, sep) : o.rationale,
  };
}

/**
 * Score all offers (buyer's LLM assessment + rule flags + code formula). Only offers without a stored
 * assessment are sent to the LLM (none on a re-score), in one call. Throws on LLM failure.
 */
export async function scoreOffers(req: RequestRow, ctxs: OfferCtx[], listings: MarketListing[]): Promise<Scored[]> {
  if (!ctxs.length) return [];
  const marketMedian = median(comparableListings(req, listings).map((l) => l.estTotalCents).filter((x) => x > 0));
  const forumMedian = median(ctxs.map((c) => c.offer.totalCents));
  const baseFlags = new Map(ctxs.map((c) => [c.offer.id, ruleFlags(req, c, marketMedian, forumMedian)]));
  const credible = ctxs.filter((c) => !baseFlags.get(c.offer.id)!.some(isSuspiciousFlag));
  const minTotal = Math.min(...(credible.length ? credible : ctxs).map((c) => c.offer.totalCents));

  const byId = new Map<string, Assessment>();
  for (const c of ctxs) {
    const a = storedAssessment(c.offer);
    if (a) byId.set(c.offer.id, a);
  }
  const toAssess = ctxs.filter((c) => !byId.has(c.offer.id));
  if (toAssess.length) {
    const o = await llmObject({
      userId: req.buyerId,
      who: "buyer",
      label: "buyer.score_offers",
      system:
        "You are a buyer's procurement analyst. For EVERY offer, assess how well the PRODUCT meets the buyer's spec (specMatch 0..1), list extra risk flags you notice that the rule flags don't already cover (short phrases, e.g. 'no warranty'), and write a one-sentence rationale. " +
        `Do not compute an overall score. ${UNTRUSTED_NOTE} Pitches are marketing claims; trust structured fields over pitch text.`,
      prompt: `BUYER SPEC: ${JSON.stringify(req.spec)}\nDays until deadline: ${daysUntil(req.deadline)}\nMarket median est. total: ${marketMedian ?? "unknown"} cents\n\nOFFERS:\n${toAssess
        .map((c) =>
          JSON.stringify({
            offerId: c.offer.id,
            seller: c.seller?.displayName,
            product: c.product ? { title: c.product.title, description: c.product.description, attributes: c.product.attributes } : null,
            unitPriceCents: c.offer.unitPriceCents,
            quantity: c.offer.quantity,
            totalCents: c.offer.totalCents,
            etaDays: c.offer.etaDays,
            warranty: c.offer.warranty,
            returnPolicy: c.offer.returnPolicy,
            terms: c.offer.terms,
            ruleFlags: baseFlags.get(c.offer.id),
            pitch_UNTRUSTED: c.offer.pitch,
          }),
        )
        .join("\n")}`,
      schema: LlmAssessSchema,
    });
    for (const a of o.assessments) if (toAssess.some((c) => c.offer.id === a.offerId)) byId.set(a.offerId, a);
  }

  return ctxs.map((c) => {
    const a = byId.get(c.offer.id);
    // An offer the model skipped gets a neutral spec match; its rationale says so.
    const specMatch01 = a ? clamp(a.specMatch, 0, 1) : 0.5;
    const flags = [...baseFlags.get(c.offer.id)!];
    for (const f of a?.extraFlags ?? []) {
      const t = f.trim().slice(0, 60);
      if (t && !flags.some((x) => x.toLowerCase().includes(t.toLowerCase().slice(0, 12)))) flags.push(t);
    }
    const aiScore = computeScore(req, c, specMatch01, flags, minTotal, marketMedian);
    const base = a?.rationale?.slice(0, 400) || NOT_ASSESSED;
    const rationale = `${base}${flags.length ? `${FLAG_SEP}${flags.join("; ")}` : ""}`;
    return { offerId: c.offer.id, aiScore, specMatch: Math.round(specMatch01 * 100), flags, rationale };
  });
}

// ---- counter plan (deterministic) ----

export type CounterPlan = { offerId: string; targetUnitPriceCents: number; message: string };
type CounterCandidate = { offer: Pick<Offer, "id" | "unitPriceCents" | "quantity" | "shippingCents" | "totalCents"> };

/** Target ≈8% below the current unit price, never more than 15% below. */
const COUNTER_DISCOUNT = 0.08;
const COUNTER_MAX_DISCOUNT = 0.15;

/**
 * Up to two counters for the best credible offers (`candidates` ranked best first, already filtered of
 * suspicious / unpayable ones): ask for a cheaper competitor's unit price or ≈8% off, lower still if
 * that keeps the total within budget, but never below 85% of the current price. The message never
 * reveals the budget or other sellers.
 */
export function planCounters(candidates: CounterCandidate[], budgetMaxCents: number, max = 2): CounterPlan[] {
  const out: CounterPlan[] = [];
  for (const c of candidates.slice(0, max)) {
    const o = c.offer;
    const unit = o.unitPriceCents;
    if (unit < 2) continue;
    const rivals = candidates.filter((r) => r.offer.id !== o.id && r.offer.unitPriceCents < unit).map((r) => r.offer.unitPriceCents);
    let target = rivals.length ? Math.max(...rivals) : Math.round(unit * (1 - COUNTER_DISCOUNT));
    if (budgetMaxCents > 0 && o.totalCents > budgetMaxCents && o.quantity > 0) {
      target = Math.min(target, Math.floor((budgetMaxCents - o.shippingCents) / o.quantity));
    }
    target = Math.min(unit - 1, Math.max(target, Math.ceil(unit * (1 - COUNTER_MAX_DISCOUNT))));
    if (target < 1 || target >= unit) continue;
    out.push({
      offerId: o.id,
      targetUnitPriceCents: target,
      message: `Thanks for the offer. Could you do ${unitUsd(target)}/unit for ${o.quantity} units? A better price would make your offer more competitive.`,
    });
  }
  return out;
}
