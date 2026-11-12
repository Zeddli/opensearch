// PATCH /api/seller/products/:id {unitPriceCents?, stock?, floorPriceCents?, maxDiscountPct?,
//   maxQtyPerOrder?, active?, title?, description?, category?, moq?, leadTimeDays?} → {product}
// Only the seller's own products. Validates floor ≤ price on the merged values.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, products } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { badRequest, handle, json, notFound, readJson } from "@/src/lib/http";

const cents = z.number().int().nonnegative();
const Body = z
  .object({
    unitPriceCents: cents.positive(),
    stock: z.number().int().nonnegative(),
    floorPriceCents: cents,
    maxDiscountPct: z.number().int().min(0).max(100),
    maxQtyPerOrder: z.number().int().positive().nullable(),
    active: z.boolean(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000),
    category: z.string().trim().min(1).max(80),
    moq: z.number().int().positive(),
    leadTimeDays: z.number().int().nonnegative(),
  })
  .partial(); // unknown keys (e.g. a full AG Grid row) are stripped, not rejected

export const PATCH = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("seller");
  const { id } = await params;
  const patch = await readJson(req, Body);
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.sellerId, user.id)))
    .limit(1);
  if (!existing) throw notFound("Product not found");
  const price = patch.unitPriceCents ?? existing.unitPriceCents;
  const floor = patch.floorPriceCents ?? existing.floorPriceCents;
  if (floor > price) throw badRequest("Floor price must be less than or equal to the unit price");
  if (Object.keys(patch).length === 0) return json({ product: existing });
  const [product] = await db.update(products).set(patch).where(eq(products.id, id)).returning();
  return json({ product });
});
