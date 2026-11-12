// Buyer agent background jobs: buyer.analyze (window end → market search → score → rule-based counters
// → wait → re-score → recommend) and buyer.answer_question (seller Q&A on the forum, answered from the spec).
// LLM calls per analysis, on the BUYER's own key: one to assess the offers (re-scores reuse it) and one for
// the recommendation text. Counters and answers to seller questions are deterministic. If the key is
// missing or the LLM fails, the buyer gets a warning card, the request goes back to `open`, and saying
// "analyze" retries.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  forumPosts,
  getDb,
  marketListings,
  offers,
  products,
  requests,
  sellerProfiles,
  type MarketListing,
  type RequestRow,
} from "@/src/db";
import { CHANNEL3_UNAVAILABLE_NOTE, isChannel3Configured, searchMarket } from "@/src/integrations/channel3";
import { enqueue } from "@/src/jobs/runner";
import { env } from "@/src/lib/env";
import type { Recommendation } from "@/src/agents/protocol";
import { hasAiKey, llmObject, MISSING_KEY_TEXT, UNTRUSTED_NOTE } from "@/src/agents/llm";
import { isAiError, postAiError } from "@/src/agents/ai-errors";
import { addMessage, addStatus, createPost, logEvent, notifySeller, randInt, SETTINGS_ACTION, unitUsd, usd } from "@/src/agents/util";
import { comparableListings, isSuspiciousFlag, isUnpayableFlag, planCounters, riskTier, scoreOffers, type OfferCtx } from "./score";

export type AnalyzePayload = { requestId: string; phase?: "initial" | "final" };
export const NEGOTIATION_WAIT_MS = 16_000;
const ACTOR = "buyer_agent";
const MARKET_UNAVAILABLE = `${CHANNEL3_UNAVAILABLE_NOTE}.`;

async function loadOfferCtxs(requestId: string): Promise<OfferCtx[]> {
  const db = await getDb();
  const rows = await db
    .select({ offer: offers, product: products, seller: sellerProfiles })
    .from(offers)
    .leftJoin(products, eq(products.id, offers.productId))
    .leftJoin(sellerProfiles, eq(sellerProfiles.userId, offers.sellerId))
    .where(and(eq(offers.requestId, requestId), inArray(offers.status, ["active", "countered", "revised"])));
  return rows;
}

async function scoreAndStore(req: RequestRow, listings: MarketListing[]) {
  const db = await getDb();
  const ctxs = await loadOfferCtxs(req.id);
  const scored = await scoreOffers(req, ctxs, listings);
  for (const s of scored) {
    await db
      .update(offers)
      .set({ aiScore: s.aiScore, specMatch: s.specMatch, flags: s.flags, rationale: s.rationale })
      .where(eq(offers.id, s.offerId));
  }
  await logEvent({
    requestId: req.id,
    actor: ACTOR,
    tool: "score_offers",
    input: { offers: ctxs.length, listings: listings.length },
    output: scored.map((s) => ({ offerId: s.offerId, aiScore: s.aiScore, flags: s.flags })),
  });
  const byId = new Map(scored.map((s) => [s.offerId, s]));
  return ctxs
    .map((c) => ({ ...c, score: byId.get(c.offer.id)! }))
    .filter((c) => c.score)
    .sort((a, b) => b.score.aiScore - a.score.aiScore);
}

async function fetchMarket(req: RequestRow): Promise<MarketListing[]> {
  const db = await getDb();
  let results: Awaited<ReturnType<typeof searchMarket>> = [];
  try {
    results = await searchMarket({
      query: [req.spec.item, ...req.spec.mustHave.filter((m) => !req.spec.item.toLowerCase().includes(m.toLowerCase()))].join(" ").slice(0, 120),
      quantity: req.spec.quantity,
      maxTotalCents: req.budgetMaxCents > 0 ? req.budgetMaxCents * 3 : undefined,
      limit: 8,
    });
  } catch (err) {
    console.error("[agents] searchMarket failed", err);
  }
  await db.delete(marketListings).where(eq(marketListings.requestId, req.id));
  const rows = results.length
    ? await db
        .insert(marketListings)
        .values(
          results.map((r) => ({
            requestId: req.id,
            source: "channel3",
            title: r.title,
            merchant: r.merchant,
            priceCents: Math.round(r.priceCents),
            estTotalCents: Math.round(r.estTotalCents),
            url: r.url,
            imageUrl: r.imageUrl,
            raw: r.raw ?? null,
          })),
        )
        .returning()
    : [];
  await logEvent({
    requestId: req.id,
    actor: ACTOR,
    tool: "search_market",
    input: { item: req.spec.item, quantity: req.spec.quantity, configured: isChannel3Configured() },
    output: rows.map((r) => ({ title: r.title, merchant: r.merchant, estTotalCents: r.estTotalCents })),
  });
  return rows;
}

/** AI failure during analysis: reopen (window already over) so "analyze" can retry, and tell the buyer. */
async function analysisFailed(req: RequestRow, err: unknown): Promise<void> {
  const db = await getDb();
  await db.update(requests).set({ status: "open" }).where(and(eq(requests.id, req.id), eq(requests.status, "analyzing")));
  await logEvent({ requestId: req.id, actor: ACTOR, tool: "analysis_failed", output: { error: err instanceof Error ? err.message : String(err) }, decision: "error" });
  await postAiError(req.sessionId, err, "analyse the offers");
  await addMessage(req.sessionId, "assistant", 'Fix that, then say **"analyze"** here and I\'ll pick up where I left off.');
}

export async function analyzeRequest(p: AnalyzePayload): Promise<void> {
  const db = await getDb();
  const phase = p.phase ?? "initial";
  const [req] = await db.select().from(requests).where(eq(requests.id, p.requestId)).limit(1);
  if (!req) return;

  if (phase === "initial") {
    if (req.status !== "open") return;
    // Window may have been extended: re-schedule if we woke up early.
    if (req.windowEndsAt && req.windowEndsAt.getTime() - Date.now() > 1500) {
      enqueue("buyer.analyze", { requestId: req.id, phase: "initial" }, { delayMs: req.windowEndsAt.getTime() - Date.now() });
      return;
    }
    const pendingCount = (await loadOfferCtxs(req.id)).length;
    if (pendingCount > 0 && !(await hasAiKey(req.buyerId))) {
      // Leave the request open; the buyer says "analyze" once a key is configured.
      await logEvent({ requestId: req.id, actor: ACTOR, tool: "missing_ai_key", decision: "analysis postponed" });
      await addStatus(
        req.sessionId,
        `The offer window closed with ${pendingCount} offer${pendingCount === 1 ? "" : "s"}. ${MISSING_KEY_TEXT} Then say "analyze" here.`,
        "warning",
        SETTINGS_ACTION,
      );
      return;
    }
    const [claimed] = await db
      .update(requests)
      .set({ status: "analyzing" })
      .where(and(eq(requests.id, req.id), eq(requests.status, "open")))
      .returning();
    if (!claimed) return;
    await createPost({
      requestId: req.id,
      authorKind: "system",
      type: "system",
      body: `Offer window closed — ${pendingCount} offer${pendingCount === 1 ? "" : "s"} received. The buyer's agent is comparing offers${isChannel3Configured() ? " with public web listings" : ""}.`,
    });

    try {
      const listings = await fetchMarket(claimed);
      const ranked = await scoreAndStore(claimed, listings);
      if (!ranked.length) return noOffers(claimed, listings);

      const posts = await db.select().from(forumPosts).where(eq(forumPosts.requestId, req.id));
      // Counter only once per request (a retried analysis skips straight to the recommendation).
      const alreadyCountered = posts.some((x) => x.type === "counter");
      const countered = alreadyCountered ? [] : await negotiate(claimed, ranked, posts);
      if (countered.length) {
        await addStatus(
          claimed.sessionId,
          `${ranked.length} offer${ranked.length === 1 ? "" : "s"} scored. Negotiating with ${countered.join(" and ")} — back in ~${Math.round(NEGOTIATION_WAIT_MS / 1000)}s.`,
          "info",
        );
        enqueue("buyer.analyze", { requestId: req.id, phase: "final" }, { delayMs: NEGOTIATION_WAIT_MS });
      } else {
        await analyzeRequest({ requestId: req.id, phase: "final" });
      }
    } catch (err) {
      if (!isAiError(err)) throw err;
      await analysisFailed(claimed, err);
    }
    return;
  }

  // ---- final phase ----
  if (req.status !== "analyzing") return;
  try {
    // Any counter still unanswered → treat as declined
    await db.update(offers).set({ status: "active" }).where(and(eq(offers.requestId, req.id), eq(offers.status, "countered")));
    const listings = await db.select().from(marketListings).where(eq(marketListings.requestId, req.id));
    const ranked = await scoreAndStore(req, listings);
    if (!ranked.length) return noOffers(req, listings);
    await recommend(req, ranked, listings);
  } catch (err) {
    if (!isAiError(err)) throw err;
    await analysisFailed(req, err);
  }
}

type Ranked = Awaited<ReturnType<typeof scoreAndStore>>;

/** Counter up to two credible offers (deterministic plan, see planCounters). Returns seller names countered. */
async function negotiate(req: RequestRow, ranked: Ranked, posts: Array<typeof forumPosts.$inferSelect>): Promise<string[]> {
  const db = await getDb();
  const candidates = ranked.filter((r) => !r.score.flags.some((f) => isSuspiciousFlag(f) || isUnpayableFlag(f))).slice(0, 4);
  if (!candidates.length) return [];
  const name = (r: Ranked[number]) => r.seller?.displayName ?? "Seller";
  const out: string[] = [];
  for (const { offerId, targetUnitPriceCents: targetUnit, message } of planCounters(candidates, req.budgetMaxCents)) {
    const t = candidates.find((r) => r.offer.id === offerId);
    if (!t) continue;
    const o = t.offer;
    const offerPost = posts.find((x) => x.offerId === o.id && x.type === "offer");
    const post = await createPost({
      requestId: req.id,
      authorKind: "buyer_agent",
      authorId: req.buyerId,
      type: "counter",
      body: message,
      offerId: o.id,
      replyTo: offerPost?.id ?? null,
    });
    await db.update(offers).set({ status: "countered" }).where(eq(offers.id, o.id));
    await logEvent({
      requestId: req.id,
      actor: ACTOR,
      tool: "send_counter",
      input: { offerId: o.id, targetUnitPriceCents: targetUnit },
      output: { postId: post.id },
      decision: "counter",
    });
    enqueue("seller.respond_counter", { offerId: o.id, counterPostId: post.id, targetUnitPriceCents: targetUnit, message }, { delayMs: randInt(3000, 8000) });
    await notifySeller(o.sellerId, `The buyer's agent countered your offer on “${req.title}” at ${unitUsd(targetUnit)}/unit. Your agent is responding…`, "info");
    out.push(name(t));
  }
  return out;
}

async function recommend(req: RequestRow, ranked: Ranked, listings: MarketListing[]) {
  const db = await getDb();
  // Top pick is chosen by risk tier first, score second (enforced here, not just via score weights):
  //   tier 0 = no flags; tier 1 = only soft flags (no return policy, over budget, quantity short);
  //   tier 2 = hard risk flags (late, vague terms); tier 3 = suspicious price;
  //   tier 4 = seller can't receive PayPal. Such offers are only ever top if every offer is in that tier.
  const tier = (r: Ranked[number]) => riskTier(r.score.flags);
  const byTier = [...ranked].sort((a, b) => tier(a) - tier(b) || b.score.aiScore - a.score.aiScore);
  const top = byTier[0];
  const alts = byTier.filter((r) => r.offer.id !== top.offer.id).slice(0, 2);
  const shortlist = [top, ...alts];
  const comparable = comparableListings(req, listings);
  const bestMarket = comparable.length ? Math.min(...comparable.map((l) => l.estTotalCents)) : null;
  const savingsVsMarketCents = bestMarket != null ? bestMarket - top.offer.totalCents : null;
  const name = (r: Ranked[number]) => r.seller?.displayName ?? "Seller";

  const marketLine = !isChannel3Configured()
    ? MARKET_UNAVAILABLE
    : savingsVsMarketCents == null
      ? "No comparable public-web listings were found."
      : savingsVsMarketCents >= 0
        ? `The top pick is ${usd(savingsVsMarketCents)} cheaper than the best comparable public-web listing (${usd(bestMarket)}).`
        : `The top pick is ${usd(-savingsVsMarketCents)} more than the cheapest comparable public-web listing (${usd(bestMarket)}).`;

  const o = await llmObject({
    userId: req.buyerId,
    who: "buyer",
    label: "buyer.recommend",
    system:
      `You are the buyer's purchasing agent. The ranking is already decided in code (top pick: ${top.offer.id}; alternatives in order: ${alts.map((a) => a.offer.id).join(", ") || "none"}). ` +
      "Write a 2–3 sentence summary for the buyer recommending the top pick and mentioning the alternatives, and a one-line reason for EVERY offer. " +
      `State the market comparison exactly as given. Use only the numbers provided. ${UNTRUSTED_NOTE}`,
    prompt: JSON.stringify({
      spec: req.spec,
      marketComparison: marketLine,
      offers: ranked.map((r) => ({
        offerId: r.offer.id,
        seller: name(r),
        product: r.product?.title,
        unitPrice: unitUsd(r.offer.unitPriceCents),
        total: usd(r.offer.totalCents),
        etaDays: r.offer.etaDays,
        aiScore: r.score.aiScore,
        flags: r.score.flags,
        assessment: r.score.rationale,
        revisedAfterCounter: r.offer.version > 1,
        shortlisted: shortlist.includes(r),
      })),
    }),
    schema: z.object({
      summary: z.string(),
      reasons: z.array(z.object({ offerId: z.string(), reason: z.string() })),
    }),
  });
  const reasons: Record<string, string> = {};
  for (const r of ranked) reasons[r.offer.id] = r.score.rationale;
  for (const r of o.reasons) if (reasons[r.offerId] != null && r.reason.trim()) reasons[r.offerId] = r.reason.trim().slice(0, 300);
  const summary = o.summary.trim().slice(0, 800);

  const recommendation: Recommendation = {
    topOfferId: top.offer.id,
    alternativeOfferIds: alts.map((a) => a.offer.id),
    summary,
    savingsVsMarketCents,
    reasons,
  };
  const [updated] = await db
    .update(requests)
    .set({ recommendation, status: "recommended" })
    .where(and(eq(requests.id, req.id), eq(requests.status, "analyzing")))
    .returning();
  if (!updated) return;
  await logEvent({ requestId: req.id, actor: ACTOR, tool: "recommend", input: { offers: ranked.length }, output: recommendation, decision: top.offer.id });
  await createPost({
    requestId: req.id,
    authorKind: "system",
    type: "system",
    body: `Analysis complete — the buyer's agent shortlisted ${shortlist.length} offer${shortlist.length === 1 ? "" : "s"} and is waiting for the buyer's approval.`,
  });
  await addMessage(req.sessionId, "assistant", summary, { type: "recommendation", requestId: req.id, recommendation });
  const flagged = ranked.filter((r) => r.score.flags.some(isSuspiciousFlag));
  const unpayable = ranked.filter((r) => r.score.flags.some(isUnpayableFlag));
  const follow =
    `Hit **Approve & pay** on the offer you want, or ask me anything ("why #2?", "what's the cheapest?").` +
    (flagged.length ? ` I flagged ${flagged.map(name).join(", ")} as risky (price far below market) and kept it off the top spot.` : "") +
    (unpayable.length ? ` ${unpayable.map(name).join(", ")} can't receive PayPal yet, so I can't pay ${unpayable.length === 1 ? "that seller" : "those sellers"}.` : "") +
    (!isChannel3Configured() ? ` ${MARKET_UNAVAILABLE}` : "");
  await addMessage(req.sessionId, "assistant", follow);
}

async function noOffers(req: RequestRow, listings: MarketListing[]) {
  const db = await getDb();
  await db.update(requests).set({ status: "recommended", recommendation: null }).where(eq(requests.id, req.id));
  const lines = listings
    .slice(0, 5)
    .map((l, i) => `${i + 1}. ${l.title} — ${l.merchant}, ~${usd(l.estTotalCents)} est. total`)
    .join("\n");
  const market = !isChannel3Configured()
    ? `${MARKET_UNAVAILABLE} `
    : listings.length
      ? `Here's what I found on the public web:\n${lines}\n\n`
      : "I couldn't find public listings either. ";
  await addMessage(
    req.sessionId,
    "assistant",
    `No seller agents made an offer in the window. ${market}Reply **"extend"** to keep collecting offers for another ${env.OFFER_WINDOW_SECONDS}s, or edit the request to relax a constraint.`,
    { type: "status", text: "No offers received", tone: "warning" },
  );
  await logEvent({ requestId: req.id, actor: ACTOR, tool: "recommend", input: { offers: 0 }, output: { listings: listings.length }, decision: "no_offers" });
}

// ---- seller question → buyer agent answer ----
export type AnswerPayload = { requestId: string; questionPostId: string };

/** The buyer agent answers seller questions from the spec alone (never the budget); no LLM call. */
export function specAnswer(s: RequestRow["spec"]): string {
  const parts = [`${s.quantity}${s.unit ? ` ${s.unit}` : ""} × ${s.item}`, `delivered to ${s.location} by ${s.deadline}`];
  if (s.mustHave.length) parts.push(`must have: ${s.mustHave.join(", ")}`);
  if (s.niceToHave.length) parts.push(`nice to have: ${s.niceToHave.join(", ")}`);
  return `The buyer's spec: ${parts.join("; ")}. Anything not listed is open — please quote your standard option.`;
}

export async function answerSellerQuestion(p: AnswerPayload): Promise<void> {
  const db = await getDb();
  const [req] = await db.select().from(requests).where(eq(requests.id, p.requestId)).limit(1);
  const [q] = await db.select().from(forumPosts).where(eq(forumPosts.id, p.questionPostId)).limit(1);
  if (!req || !q || req.status !== "open") return;
  const answer = specAnswer(req.spec);
  const post = await createPost({ requestId: req.id, authorKind: "buyer_agent", authorId: req.buyerId, type: "answer", body: answer.slice(0, 600), replyTo: q.id });
  await logEvent({ requestId: req.id, actor: ACTOR, tool: "answer_seller_question", input: { questionPostId: q.id, question: q.body }, output: { postId: post.id, answer }, decision: "answered" });
  await addStatus(
    req.sessionId,
    `A seller asked: “${q.body.slice(0, 160)}” — I replied with your spec and asked them to quote their standard option for anything not listed. Tell me if you want to add details.`,
    "info",
  );
  if (q.authorId) enqueue("seller.consider", { requestId: req.id, sellerId: q.authorId, afterAnswer: true }, { delayMs: randInt(2000, 4000) });
}
