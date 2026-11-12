// Seller chat: short "how are my deals going?" questions get a factual DB summary without an LLM call;
// otherwise the seller's LLM reads the message and either extracts a product (→ product_confirm card),
// asks for the deals summary, or replies conversationally.
import { cleanReply } from "@/src/agents/clean-reply";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, offers, products, requests, sellerProfiles, type ChatSession, type MessageRow, type User } from "@/src/db";
import { ProductDraftSchema, type ProductDraft } from "@/src/agents/protocol";
import { sellerCanReceivePayPal } from "@/src/policy";
import { llmObject } from "@/src/agents/llm";
import { addMessage, logEvent, unitUsd, usd } from "@/src/agents/util";

const SellerTurnSchema = z.object({
  intent: z.enum(["add_product", "deals_status", "other"]),
  product: z
    .object({
      title: z.string(),
      description: z.string(),
      category: z.string().describe("Short lowercase category, e.g. cups, packaging, electronics, coffee, cafe-equipment, furniture, general"),
      unitPriceUsd: z.number().nullable().describe("Per-unit list price. If a range is given (e.g. '6-9 dollars each'), use the HIGH end"),
      stock: z.number().int().nullable(),
      moq: z.number().int().nullable(),
      leadTimeDays: z.number().int().nullable().describe("Max of any range given"),
      floorPriceUsd: z
        .number()
        .nullable()
        .describe("Minimum acceptable per-unit price: the LOW end of a stated price range, or a stated minimum; else null"),
      maxDiscountPct: z.number().int().nullable().describe("Only if stated"),
      shippingUsd: z.number().nullable().describe("Flat shipping per order, only if stated"),
      warranty: z.string().nullable(),
      returnPolicy: z.string().nullable(),
      attributes: z.array(z.object({ key: z.string(), value: z.string() })).describe("Size, material, certifications, etc."),
    })
    .nullable()
    .describe("For intent=add_product only"),
  reply: z
    .string()
    .describe(
      "For add_product without a unit price: ask for the missing price (and any other key details). For other: a short helpful answer about what you can do (add products, report deals, auto-reply to buyer requests within guardrails).",
    ),
});

/**
 * Messages that clearly describe something to sell (sell/list/add/publish/stock + a number or price) are always
 * handled as add_product — small models sometimes misclassify "help me sell 100 toys at $6-9" as a deals question.
 */
export function looksLikeProductListing(text: string): boolean {
  const t = text.toLowerCase();
  const verb = /\b(sell|selling|list|listing|add|publish|offer|stock|supply|have)\b/.test(t);
  const priceish = /[$€£]|\b\d+(\.\d+)?\s*(-|–|to)?\s*\d*(\.\d+)?\s*(usd|dollars?|bucks|each|per|\/\s*(unit|pc|piece))\b/.test(t);
  return verb && (priceish || /\d/.test(t)) && !isDealsQuestion(text);
}

/** Short "how are my deals going?"-style questions are answered from the DB without an LLM call. */
export function isDealsQuestion(text: string): boolean {
  const t = text.trim();
  return t.length <= 80 && !/[$€£\d]/.test(t) && /\b(deals?|sales|sold|offers?|orders?)\b/i.test(t) && /\b(how|status|update|any|show|what|list)\b/i.test(t);
}

export async function handleSellerChat(session: ChatSession, user: User, text: string): Promise<MessageRow[]> {
  if (isDealsQuestion(text)) return [await addMessage(session.id, "assistant", await dealsSummary(user.id))];
  const o = await llmObject({
    userId: user.id,
    who: "seller",
    label: "seller.chat",
    system:
      "You are the seller's agent on OpenQuote, a B2B marketplace where agents answer buyer requests. Classify the seller's message and, if they describe something they sell, extract ONE product listing. " +
      "Use null for anything the seller did not state. Never invent prices, stock or terms.",
    prompt: text,
    schema: SellerTurnSchema,
    maxOutputTokens: 3000,
  });

  const forcedProduct = looksLikeProductListing(text);
  const intent = forcedProduct ? "add_product" : o.intent;

  if (intent === "deals_status") return [await addMessage(session.id, "assistant", await dealsSummary(user.id))];

  if (intent === "add_product") {
    const draft = o.product ? toDraft(o.product, text) : null;
    if (!draft) {
      const reply = o.intent === "add_product" ? cleanReply(o.reply) : "";
      return [
        await addMessage(
          session.id,
          "assistant",
          reply ||
            "I can add that to your catalog. What's the **unit price** (a range like $6–9 is fine — I'll use the low end as your floor), and how many do you have in **stock**?",
        ),
      ];
    }
    await logEvent({ actor: `seller_agent:${user.id}`, tool: "extract_product", input: { text }, output: draft });
    const missing = [o.product?.stock == null && "stock", o.product?.moq == null && "MOQ", o.product?.leadTimeDays == null && "lead time"].filter(Boolean);
    return [
      await addMessage(
        session.id,
        "assistant",
        `Here's the product I extracted. Your floor price is ${unitUsd(draft.floorPriceCents)} and max discount ${draft.maxDiscountPct}% — your agent will never offer below that.` +
          (missing.length ? ` You didn't mention ${missing.join(", ")}, so please check those fields.` : "") +
          " Edit anything, then hit **Save product**.",
        { type: "product_confirm", draft },
      ),
    ];
  }

  return [await addMessage(session.id, "assistant", cleanReply(o.reply) || "Describe a product to add it, or ask how your deals are going.")];
}

type LlmProduct = NonNullable<z.infer<typeof SellerTurnSchema>["product"]>;

/** Validate + normalise the LLM's extraction into a ProductDraft (null if there's no usable price). */
function toDraft(p: LlmProduct, text: string): ProductDraft | null {
  if (!p.title.trim() || !(p.unitPriceUsd != null && p.unitPriceUsd > 0)) return null;
  const unitPriceCents = Math.round(p.unitPriceUsd * 100);
  const moq = Math.max(1, p.moq ?? 1);
  const attributes: Record<string, unknown> = Object.fromEntries(p.attributes.filter((a) => a.key.trim()).map((a) => [a.key.trim(), a.value]));
  if (p.shippingUsd != null && p.shippingUsd >= 0) attributes.shippingCents = Math.round(p.shippingUsd * 100);
  if (p.warranty?.trim()) attributes.warranty = p.warranty.trim();
  if (p.returnPolicy?.trim()) attributes.returnPolicy = p.returnPolicy.trim();
  return ProductDraftSchema.parse({
    title: p.title.trim().slice(0, 100),
    description: (p.description.trim() || text.trim()).slice(0, 400),
    category: p.category.trim().toLowerCase() || "general",
    unitPriceCents,
    stock: Math.max(0, p.stock ?? 0),
    moq,
    leadTimeDays: Math.max(0, p.leadTimeDays ?? 0),
    // Default guardrail when none is stated: floor at 85% of list, max 15% discount (seller can edit).
    floorPriceCents: p.floorPriceUsd != null && p.floorPriceUsd > 0 ? Math.min(unitPriceCents, Math.round(p.floorPriceUsd * 100)) : Math.round(unitPriceCents * 0.85),
    maxDiscountPct: Math.min(100, Math.max(0, p.maxDiscountPct ?? 15)),
    attributes,
  });
}

// ---- deals summary (factual, from the DB) ----
export async function dealsSummary(sellerId: string): Promise<string> {
  const db = await getDb();
  const rows = await db
    .select({ offer: offers, title: requests.title, reqStatus: requests.status })
    .from(offers)
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .where(eq(offers.sellerId, sellerId))
    .orderBy(desc(offers.updatedAt))
    .limit(20);
  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, sellerId)).limit(1);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.sellerId, sellerId), eq(products.active, true)));
  if (!rows.length) {
    return (
      `No deals yet. You have ${n} active product${n === 1 ? "" : "s"}; auto-deal is ${profile?.autoDeal ? "ON" : "OFF"}. Your agent replies automatically when a matching buyer request is posted.` +
      (n === 0 ? "\nTo get started, describe a product with its price, e.g. \"I sell dinosaur toys, $9 each, 100 in stock, ships in 5 days\"." : "")
    );
  }
  const won = rows.filter((r) => r.offer.status === "won");
  const lost = rows.filter((r) => r.offer.status === "lost");
  const live = rows.filter((r) => ["active", "countered", "revised"].includes(r.offer.status));
  const revenue = won.reduce((a, r) => a + r.offer.totalCents, 0);
  const lines = rows.slice(0, 6).map((r) => {
    const s = r.offer.status === "won" ? "won ✓" : r.offer.status === "lost" ? "not selected" : r.offer.status === "revised" ? "revised after counter" : r.offer.status;
    return `• ${r.title}: ${unitUsd(r.offer.unitPriceCents)}/unit, ${usd(r.offer.totalCents)} — ${s}`;
  });
  const payNote = !sellerCanReceivePayPal(profile) ? "\n⚠️ PayPal isn't connected yet — connect it in Settings so buyers can pay you." : "";
  return `${live.length} live offer${live.length === 1 ? "" : "s"}, ${won.length} won (${usd(revenue)}), ${lost.length} lost.\n${lines.join("\n")}${payNote}`;
}
