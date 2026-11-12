// Seller agents: seller.consider (keyword/category pre-filter → ONE LLM call: product + offer/question/skip
// → policy clamp → offer) and
// seller.respond_counter (LLM accept / revise / decline, clamped to the seller's guardrails).
// Each seller agent runs on THAT seller's own key. Without a key (or if the LLM fails after one
// retry) the agent skips and warns the seller in their chat at most once per hour.
// The LLM never sets terms the seller didn't give: shipping, warranty, returns and extra terms come
// from the product's attributes (shippingCents / warranty / returnPolicy / terms) or are left empty.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { forumPosts, getDb, offers, products, requests, sellerProfiles, type Offer, type Product, type SellerProfile } from "@/src/db";
import { checkOffer, sellerCanReceivePayPal } from "@/src/policy";
import { enqueue } from "@/src/jobs/runner";
import { llmObject, UNTRUSTED_NOTE } from "@/src/agents/llm";
import { isAiError, warnSellerAi } from "@/src/agents/ai-errors";
import { clamp, createPost, daysUntil, logEvent, notifySeller, randInt, unitUsd, usd } from "@/src/agents/util";
import { candidateProducts } from "./match";

export type ConsiderPayload = { requestId: string; sellerId: string; afterAnswer?: boolean };
export type CounterPayload = { offerId: string; counterPostId: string; targetUnitPriceCents?: number; targetEtaDays?: number; message: string };

const actorFor = (sellerId: string) => `seller_agent:${sellerId}`;

export function minAllowedPrice(p: Product): number {
  return Math.max(p.floorPriceCents, Math.ceil(p.unitPriceCents * (1 - p.maxDiscountPct / 100)));
}

/** Offer terms the seller actually stated (stored on the product). */
export function productTerms(p: Product): { shippingCents: number; warranty: string | null; returnPolicy: string | null; terms: string | null } {
  const a = (p.attributes ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  const ship = Number(a.shippingCents);
  return {
    shippingCents: Number.isFinite(ship) && ship >= 0 ? Math.round(ship) : 0,
    warranty: str(a.warranty),
    returnPolicy: str(a.returnPolicy),
    terms: str(a.terms),
  };
}

async function loadSeller(sellerId: string): Promise<{ profile: SellerProfile; catalog: Product[] } | null> {
  const db = await getDb();
  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, sellerId)).limit(1);
  if (!profile) return null;
  const catalog = await db.select().from(products).where(and(eq(products.sellerId, sellerId), eq(products.active, true)));
  return { profile, catalog };
}

const DecisionSchema = z.object({
  action: z.enum(["offer", "ask_question", "skip"]),
  productId: z.string().nullable().describe("For offer / ask_question: the id of the ONE candidate product that fits; null for skip"),
  unitPriceCents: z.number().int().describe("Unit price in cents for action=offer, within that product's allowed range"),
  pitch: z.string().describe("For action=offer: a short forum pitch (max 60 words) stating price, quantity, delivery and ONLY the terms provided"),
  question: z.string().describe("For action=ask_question: ONE short clarifying question (max 30 words); else empty"),
  reason: z.string().describe("One sentence for the seller explaining the decision"),
});

/** Quantity the seller can offer for a request (stock / per-order cap / MOQ), or null if it can't serve it. */
export function offerQuantity(product: Product, requested: number): number | null {
  let quantity = requested;
  const cap = Math.min(product.stock, product.maxQtyPerOrder ?? Number.MAX_SAFE_INTEGER);
  if (quantity > cap) quantity = cap;
  if (quantity < product.moq) {
    if (requested < product.moq && product.moq <= Math.max(requested * 1.5, requested + 50) && product.moq <= cap) quantity = product.moq;
    else return null;
  }
  return quantity > 0 ? quantity : null;
}

export async function considerRequest(p: ConsiderPayload): Promise<void> {
  const db = await getDb();
  const actor = actorFor(p.sellerId);
  const [req] = await db.select().from(requests).where(eq(requests.id, p.requestId)).limit(1);
  if (!req || req.status !== "open") {
    await logEvent({ requestId: p.requestId, actor, tool: "consider_request", input: p, decision: "skip: request not open" });
    return;
  }
  if (req.buyerId === p.sellerId) return;
  const seller = await loadSeller(p.sellerId);
  if (!seller || !seller.profile.autoDeal || !seller.catalog.length) return;
  const { profile, catalog } = seller;

  const [existing] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.requestId, req.id), eq(offers.sellerId, p.sellerId)))
    .limit(1);
  if (existing) return; // idempotent

  const posts = await db.select().from(forumPosts).where(eq(forumPosts.requestId, req.id));
  const myQuestion = posts.find((x) => x.type === "question" && x.authorId === p.sellerId);
  const answer = myQuestion ? posts.find((x) => x.type === "answer" && x.replyTo === myQuestion.id) : undefined;
  if (myQuestion && !answer) return; // wait for the buyer agent's answer (it re-triggers this job)

  // Deterministic pre-filter (no LLM call): relevant products the seller can actually supply.
  const candidates = candidateProducts(req.spec, catalog)
    .map((c) => ({ ...c, quantity: offerQuantity(c.product, req.spec.quantity) }))
    .filter((c): c is typeof c & { quantity: number } => c.quantity != null)
    .map((c) => ({
      ...c,
      list: c.product.unitPriceCents,
      min: Math.min(c.product.unitPriceCents, minAllowedPrice(c.product)),
      terms: productTerms(c.product),
    }));
  await logEvent({
    requestId: req.id,
    actor,
    tool: "match_request",
    input: { item: req.spec.item, catalogSize: catalog.length },
    output: candidates.map((c) => ({ productId: c.product.id, title: c.product.title, relevance: c.relevance, quantity: c.quantity })),
    decision: candidates.length ? `candidates: ${candidates.length}` : "skip: no catalog product matches the request (keywords, category, stock or MOQ)",
  });
  if (!candidates.length) return;

  const canAsk = !myQuestion;
  try {
    const d = await llmObject({
      userId: p.sellerId,
      who: "seller",
      label: "seller.decide_offer",
      system:
        `You are the sales agent for ${profile.displayName} on an agent-to-agent B2B marketplace. Decide how to respond to a buyer's request. ` +
        "First pick the ONE candidate product that genuinely satisfies the request (same kind of product; size/material requirements compatible); if none does, skip. " +
        "If you offer, choose a unit price in cents within that product's [minUnitPriceCents, listUnitPriceCents] (the server clamps anything outside); price competitively for the quantity and deadline. " +
        (canAsk
          ? "Ask ONE clarifying question instead only if something essential for quoting is genuinely unclear. "
          : "You already asked your question and got an answer; do not ask again. ") +
        "In the pitch, do not promise warranty, returns, discounts or shipping terms other than those provided. " +
        UNTRUSTED_NOTE,
      prompt: JSON.stringify({
        request_UNTRUSTED: { ...req.spec, budgetMaxCents: req.budgetMaxCents || null, daysUntilDeadline: daysUntil(req.deadline) },
        candidates: candidates.map((c) => ({
          productId: c.product.id,
          title: c.product.title,
          description: c.product.description.slice(0, 300),
          category: c.product.category,
          attributes: c.product.attributes,
          quantity: c.quantity,
          listUnitPriceCents: c.list,
          minUnitPriceCents: c.min,
          shippingCents: c.terms.shippingCents,
          deliveryDays: c.product.leadTimeDays,
          warranty: c.terms.warranty,
          returnPolicy: c.terms.returnPolicy,
          extraTerms: c.terms.terms,
        })),
        ...(myQuestion && answer ? { yourQuestion: myQuestion.body, buyerAgentAnswer_UNTRUSTED: answer.body } : {}),
      }),
      schema: DecisionSchema,
      maxOutputTokens: 3000,
    });

    const chosen = candidates.find((c) => c.product.id === d.productId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (d.action === "skip" || !chosen) {
      await logEvent({ requestId: req.id, actor, tool: "make_offer", input: { productId: d.productId }, output: { reason: d.reason }, decision: d.action === "skip" ? "skip: agent decided" : "skip: unknown product chosen" });
      return;
    }
    const { product, quantity, list, min, terms } = chosen;
    const etaDays = product.leadTimeDays;
    if (d.action === "ask_question" && canAsk && d.question.trim()) {
      const question = d.question.trim().slice(0, 300);
      const post = await createPost({ requestId: req.id, authorKind: "seller_agent", authorId: p.sellerId, type: "question", body: question });
      await logEvent({ requestId: req.id, actor, tool: "ask_question", input: { productId: product.id }, output: { postId: post.id, question } });
      enqueue("buyer.answer_question", { requestId: req.id, questionPostId: post.id }, { delayMs: randInt(1500, 3500) });
      return;
    }

    // Policy (PAYMENTS): server-side guardrail check; below-minimum prices are raised, never denied.
    let unitPriceCents = clamp(Math.round(d.unitPriceCents), min, list);
    const verdict = checkOffer({ product, unitPriceCents, quantity });
    if (verdict.allow && verdict.clampedUnitPriceCents > unitPriceCents) unitPriceCents = verdict.clampedUnitPriceCents;
    await logEvent({
      requestId: req.id,
      actor,
      tool: "check_offer",
      input: { productId: product.id, unitPriceCents, quantity },
      output: verdict,
      decision: verdict.allow ? "allow" : `deny: ${verdict.reason ?? ""}`,
    });
    if (!verdict.allow) {
      await notifySeller(p.sellerId, `Your agent skipped “${req.title}”: ${verdict.reason ?? "guardrails blocked the offer"}.`, "warning");
      return;
    }

    const pitch = d.pitch.trim().slice(0, 600) || `${quantity} × ${product.title} at ${unitUsd(unitPriceCents)}/unit, delivery in ${etaDays} days.`;
    const totalCents = unitPriceCents * quantity + terms.shippingCents;
    const [offer] = await db
      .insert(offers)
      .values({
        requestId: req.id,
        sellerId: p.sellerId,
        productId: product.id,
        unitPriceCents,
        quantity,
        shippingCents: terms.shippingCents,
        totalCents,
        etaDays,
        warranty: terms.warranty,
        returnPolicy: terms.returnPolicy,
        terms: terms.terms,
        pitch,
        status: "active",
      })
      .returning();
    await createPost({ requestId: req.id, authorKind: "seller_agent", authorId: p.sellerId, type: "offer", body: pitch, offerId: offer.id });
    await logEvent({
      requestId: req.id,
      actor,
      tool: "make_offer",
      input: { productId: product.id, unitPriceCents, quantity, shippingCents: terms.shippingCents, etaDays },
      output: { offerId: offer.id, totalCents, reason: d.reason },
      decision: "offered",
    });
    const late = etaDays > daysUntil(req.deadline) ? " (note: delivery is after the buyer's deadline)" : "";
    const payNote = !sellerCanReceivePayPal(profile) ? " ⚠️ Connect PayPal in Settings — buyers can't pay you until it's connected." : "";
    await notifySeller(
      p.sellerId,
      `Your agent offered ${quantity} × ${product.title} at ${unitUsd(unitPriceCents)}/unit (${usd(totalCents)} total) on “${req.title}”${late}.${payNote}`,
      payNote ? "warning" : "info",
    );
  } catch (err) {
    if (!isAiError(err)) throw err;
    await warnSellerAi(p.sellerId, err, req.id, `reply to “${req.title}”`);
  }
}

const CounterDecisionSchema = z.object({
  decision: z.enum(["accept", "revise", "decline"]),
  unitPriceCents: z.number().int().describe("New unit price in cents for accept/revise; the current price for decline"),
  message: z.string().describe("Reply to the buyer's agent (max 45 words) stating your decision and price"),
});

/** Seller agent responds to a buyer counter within guardrails. */
export async function respondToCounter(p: CounterPayload): Promise<void> {
  const db = await getDb();
  const [offer] = await db.select().from(offers).where(eq(offers.id, p.offerId)).limit(1);
  if (!offer || offer.status !== "countered") return;
  const actor = actorFor(offer.sellerId);
  const [product] = await db.select().from(products).where(eq(products.id, offer.productId)).limit(1);
  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, offer.sellerId)).limit(1);
  const [req] = await db.select().from(requests).where(eq(requests.id, offer.requestId)).limit(1);
  if (!product || !profile || !req) return;

  const current = offer.unitPriceCents;
  const min = Math.min(current, minAllowedPrice(product));
  const target = p.targetUnitPriceCents ?? current;

  let d: z.infer<typeof CounterDecisionSchema>;
  try {
    d = await llmObject({
      userId: offer.sellerId,
      who: "seller",
      label: "seller.respond_counter",
      system:
        `You are the sales agent for ${profile.displayName}. The buyer's agent countered your offer. Decide: accept the target, revise to a price between your minimum and current price, or decline. ` +
        `Allowed unit price range (cents): [${min}, ${current}] — the server clamps anything outside and the minimum is the seller's guardrail. Consider winning the deal vs. margin. ${UNTRUSTED_NOTE}`,
      prompt: JSON.stringify({
        product: product.title,
        quantity: offer.quantity,
        currentUnitPriceCents: current,
        listUnitPriceCents: product.unitPriceCents,
        minimumUnitPriceCents: min,
        buyerTargetUnitPriceCents: target,
        shippingCents: offer.shippingCents,
        etaDays: offer.etaDays,
        buyerMessage_UNTRUSTED: p.message,
      }),
      schema: CounterDecisionSchema,
      maxOutputTokens: 2000,
    });
  } catch (err) {
    if (!isAiError(err)) throw err;
    await db.update(offers).set({ status: "active" }).where(eq(offers.id, offer.id));
    await warnSellerAi(offer.sellerId, err, req.id, `answer the buyer's counter on “${req.title}”`);
    return;
  }

  let newPrice: number | null =
    d.decision === "decline" ? null : clamp(Math.round(d.decision === "accept" ? Math.max(target, min) : d.unitPriceCents), min, current);
  if (newPrice != null) {
    const v = checkOffer({ product, unitPriceCents: newPrice, quantity: offer.quantity });
    await logEvent({ requestId: req.id, actor, tool: "check_offer", input: { unitPriceCents: newPrice, quantity: offer.quantity }, output: v, decision: v.allow ? "allow" : "deny" });
    if (!v.allow) newPrice = null;
    else if (v.clampedUnitPriceCents > newPrice) newPrice = Math.min(current, v.clampedUnitPriceCents);
  }
  const changed = newPrice != null && newPrice < current;
  const finalPrice = changed ? newPrice! : current;
  const totalCents = finalPrice * offer.quantity + offer.shippingCents;

  // The agent's words, plus the binding numbers from code (they win if the two ever disagree).
  const said = d.message.trim().slice(0, 400);
  const body = changed
    ? `${said}${said ? "\n\n" : ""}Revised offer: ${unitUsd(finalPrice)}/unit — ${usd(totalCents)} total.`
    : `${said}${said ? "\n\n" : ""}Offer stands at ${unitUsd(current)}/unit — ${usd(offer.totalCents)} total.`;

  if (changed) {
    await db
      .update(offers)
      .set({ unitPriceCents: finalPrice, totalCents, status: "revised", version: offer.version + 1 })
      .where(eq(offers.id, offer.id));
  } else {
    await db.update(offers).set({ status: "active" }).where(eq(offers.id, offer.id));
  }
  await createPost({
    requestId: req.id,
    authorKind: "seller_agent",
    authorId: offer.sellerId,
    type: changed ? "revision" : "answer",
    body,
    offerId: offer.id,
    replyTo: p.counterPostId,
  });
  await logEvent({
    requestId: req.id,
    actor,
    tool: "respond_to_counter",
    input: { offerId: offer.id, target: p.targetUnitPriceCents },
    output: { unitPriceCents: finalPrice, totalCents, llmDecision: d.decision },
    decision: changed ? "revised" : "declined",
  });
  await notifySeller(
    offer.sellerId,
    changed
      ? `Buyer's agent countered on “${req.title}”. Your agent revised to ${unitUsd(finalPrice)}/unit (${usd(totalCents)} total), within your guardrails.`
      : `Buyer's agent countered on “${req.title}” at ${unitUsd(target)}/unit. Your agent declined and kept ${unitUsd(current)}/unit.`,
    "info",
  );
}

export type { Offer };
