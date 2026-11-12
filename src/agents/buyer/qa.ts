// Buyer chat after posting: answers questions from DB state ("why #2?", "what's the cheapest?") via the
// buyer's LLM, plus two commands: "extend" (reopen the window) and "analyze" (run a pending analysis).
import { cleanReply } from "@/src/agents/clean-reply";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  getDb,
  marketListings,
  messages,
  offers,
  products,
  requests,
  sellerProfiles,
  type ChatSession,
  type MessageRow,
  type RequestRow,
  type User,
} from "@/src/db";
import { env } from "@/src/lib/env";
import { onRequestPosted } from "@/src/agents/hooks";
import { llmText, UNTRUSTED_NOTE } from "@/src/agents/llm";
import { enqueue } from "@/src/jobs/runner";
import { addMessage, addStatus, daysUntil, logEvent, unitUsd, usd } from "@/src/agents/util";

async function context(req: RequestRow) {
  const db = await getDb();
  const rows = await db
    .select({ offer: offers, product: products, seller: sellerProfiles })
    .from(offers)
    .leftJoin(products, eq(products.id, offers.productId))
    .leftJoin(sellerProfiles, eq(sellerProfiles.userId, offers.sellerId))
    .where(eq(offers.requestId, req.id))
    .orderBy(desc(offers.aiScore));
  const listings = await db.select().from(marketListings).where(eq(marketListings.requestId, req.id)).orderBy(asc(marketListings.estTotalCents));
  // Shortlist order (as shown on the recommendation card), then the rest by score.
  const rec = req.recommendation;
  const order = rec ? [rec.topOfferId, ...rec.alternativeOfferIds] : [];
  const ranked = [
    ...order.map((id) => rows.find((r) => r.offer.id === id)).filter((r): r is (typeof rows)[number] => Boolean(r)),
    ...rows.filter((r) => !order.includes(r.offer.id)),
  ];
  return { ranked, listings };
}

const EXTEND = /\b(extend|more time|keep (?:collecting|waiting)|wait longer|reopen)\b/i;

export async function extendWindow(req: RequestRow): Promise<MessageRow[]> {
  const db = await getDb();
  const windowEndsAt = new Date(Date.now() + env.OFFER_WINDOW_SECONDS * 1000);
  await db.update(requests).set({ status: "open", windowEndsAt, recommendation: null }).where(eq(requests.id, req.id));
  await logEvent({ requestId: req.id, actor: "buyer_agent", tool: "extend_window", input: {}, output: { windowEndsAt: windowEndsAt.toISOString() } });
  await onRequestPosted(req.id);
  return [await addStatus(req.sessionId, `Extended — collecting offers for another ${env.OFFER_WINDOW_SECONDS}s.`, "info")];
}

/** "analyze" after a window closed while analysis couldn't run (e.g. no AI key at the time). */
const ANALYZE = /\b(analy[sz]e|compare|recommend|retry|try again)\b/i;

/** Chat history for the LLM: must start with a user turn; cards are summarised as their text. */
function chatHistory(rows: Array<{ role: string; content: string }>): Array<{ role: "user" | "assistant"; content: string }> {
  const out = rows.map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.content || "(card)" }));
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function answerBuyerChat(session: ChatSession, user: User, req: RequestRow, text: string): Promise<MessageRow[]> {
  const db = await getDb();
  if (EXTEND.test(text) && (req.status === "open" || (req.status === "recommended" && !req.recommendation))) {
    return extendWindow(req);
  }
  const windowOver = !req.windowEndsAt || req.windowEndsAt.getTime() <= Date.now();
  if (ANALYZE.test(text) && req.status === "open" && windowOver) {
    await logEvent({ requestId: req.id, actor: "buyer_agent", tool: "retry_analysis", input: { text } });
    enqueue("buyer.analyze", { requestId: req.id, phase: "initial" });
    return [await addStatus(req.sessionId, "Analysing the offers now — I'll post the recommendation here.", "info")];
  }
  const { ranked, listings } = await context(req);
  const name = (r: (typeof ranked)[number]) => r.seller?.displayName ?? "Seller";

  const reply = await (async () => {
      const history = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(and(eq(messages.sessionId, session.id)))
        .orderBy(desc(messages.createdAt))
        .limit(12);
      const ctx = {
        request: { title: req.title, status: req.status, spec: req.spec, windowEndsAt: req.windowEndsAt, daysUntilDeadline: daysUntil(req.deadline) },
        recommendation: req.recommendation,
        offersInDisplayOrder: ranked.map((r, i) => ({
          rank: i + 1,
          offerId: r.offer.id,
          seller: name(r),
          sellerRating: r.seller?.rating,
          product: r.product?.title,
          unitPrice: unitUsd(r.offer.unitPriceCents),
          total: usd(r.offer.totalCents),
          etaDays: r.offer.etaDays,
          status: r.offer.status,
          aiScore: r.offer.aiScore,
          specMatchPct: r.offer.specMatch,
          flags: r.offer.flags,
          rationale: r.offer.rationale,
          warranty: r.offer.warranty,
          returnPolicy: r.offer.returnPolicy,
          pitch_UNTRUSTED: r.offer.pitch,
        })),
        marketListings: listings.slice(0, 6).map((l) => ({ title: l.title, merchant: l.merchant, estTotal: usd(l.estTotalCents) })),
      };
      return llmText({
        userId: user.id,
        who: "buyer",
        label: "buyer.chat_qa",
        system:
          `You are the buyer's purchasing agent on OpenQuote. Answer the buyer's question concisely (max ~120 words) using ONLY this state:\n${JSON.stringify(ctx)}\n` +
          `"#N" refers to rank N in offersInDisplayOrder. You cannot pay or change anything from chat — to pay, the buyer presses "Approve & pay" on the recommendation card; to extend the offer window they say "extend". ${UNTRUSTED_NOTE}`,
        messages: chatHistory(history.reverse()),
      });
  })();
  return [await addMessage(session.id, "assistant", cleanReply(reply) || reply)];
}
