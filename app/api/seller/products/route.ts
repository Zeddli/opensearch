// GET /api/seller/products → {products}
// POST /api/seller/products {draft, messageId?} (or the draft itself) → {product}
//   Saves a ProductDraft from the chat product_confirm card (source 'chat'). If messageId is given
//   and it's the seller's own product_confirm card, the card is updated with savedProductId.
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ProductDraftSchema, type Card } from "@/src/agents/protocol";
import { chatSessions, getDb, messages, products } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { badRequest, handle, json, readJson } from "@/src/lib/http";

const Draft = ProductDraftSchema.extend({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().max(5000).default(""),
  category: z.string().trim().min(1).max(80).default("general"),
  attributes: z.record(z.string(), z.unknown()).default({}),
  maxQtyPerOrder: z.number().int().positive().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
});

const Body = z.union([
  z.object({ draft: Draft, messageId: z.string().optional() }),
  Draft.transform((draft) => ({ draft, messageId: undefined as string | undefined })),
]);

export const GET = handle(async () => {
  const user = await requireUser("seller");
  const db = await getDb();
  const rows = await db.select().from(products).where(eq(products.sellerId, user.id)).orderBy(desc(products.createdAt));
  return json({ products: rows });
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser("seller");
  const { draft, messageId } = await readJson(req, Body);
  if (draft.floorPriceCents > draft.unitPriceCents) {
    throw badRequest("Floor price must be less than or equal to the unit price");
  }
  const db = await getDb();
  const [product] = await db
    .insert(products)
    .values({
      sellerId: user.id,
      source: "chat",
      title: draft.title,
      description: draft.description,
      category: draft.category,
      unitPriceCents: draft.unitPriceCents,
      stock: draft.stock,
      moq: draft.moq,
      leadTimeDays: draft.leadTimeDays,
      attributes: draft.attributes,
      floorPriceCents: draft.floorPriceCents,
      maxDiscountPct: draft.maxDiscountPct,
      maxQtyPerOrder: draft.maxQtyPerOrder ?? null,
      imageUrl: draft.imageUrl ?? null,
    })
    .returning();

  if (messageId) {
    const [m] = await db
      .select({ id: messages.id, card: messages.card, owner: chatSessions.userId })
      .from(messages)
      .innerJoin(chatSessions, eq(chatSessions.id, messages.sessionId))
      .where(eq(messages.id, messageId))
      .limit(1);
    if (m && m.owner === user.id && m.card?.type === "product_confirm") {
      const card: Card = { ...m.card, savedProductId: product.id };
      await db.update(messages).set({ card }).where(eq(messages.id, m.id));
    }
  }
  return json({ product }, 201);
});
