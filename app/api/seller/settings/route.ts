// GET /api/seller/settings → {settings}
// PATCH /api/seller/settings {paypalMerchantId?, autoDeal?, displayName?, tagline?} → {settings}
//   paypalMerchantId paste-in sets onboarding_status 'complete' (null/"" clears it → 'none').
// Never returns the Shopify token — only the connected domain.
// payoutReady = buyers can pay this seller (a PayPal merchant id is set and PayPal is configured on the server).
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, products, sellerProfiles } from "@/src/db";
import { getConnection } from "@/src/integrations/shopify";
import { requireUser } from "@/src/lib/auth";
import { handle, json, notFound, readJson } from "@/src/lib/http";
import { isPayPalConfigured } from "@/src/integrations/paypal";
import { sellerCanReceivePayPal } from "@/src/policy";

const Body = z
  .object({
    paypalMerchantId: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z0-9]*$/, "PayPal merchant ID should be letters and digits only")
      .nullable(),
    autoDeal: z.boolean(),
    displayName: z.string().trim().min(1).max(80),
    tagline: z.string().trim().max(200),
  })
  .partial(); // unknown keys (e.g. the full GET payload sent back) are stripped

async function loadSettings(userId: string) {
  const db = await getDb();
  const [p] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId)).limit(1);
  if (!p) throw notFound("Seller profile not found");
  const counts = await db
    .select({
      source: products.source,
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${products.active})::int`,
    })
    .from(products)
    .where(eq(products.sellerId, userId))
    .groupBy(products.source);
  const bySource: Record<string, number> = { chat: 0, shopify: 0 };
  let total = 0;
  let active = 0;
  for (const c of counts) {
    bySource[c.source] = c.total;
    total += c.total;
    active += c.active;
  }
  const conn = p.shopifyDomain && p.shopifyTokenEnc ? await getConnection(userId) : null;
  return {
    displayName: p.displayName,
    tagline: p.tagline,
    rating: p.rating,
    paypalMerchantId: p.paypalMerchantId,
    onboardingStatus: p.onboardingStatus,
    platformFeeEnabled: p.platformFeeEnabled,
    paypal: isPayPalConfigured() ? ("configured" as const) : ("missing" as const),
    payoutReady: isPayPalConfigured() && sellerCanReceivePayPal(p),
    autoDeal: p.autoDeal,
    shopify: {
      connected: Boolean(conn),
      domain: conn?.domain ?? null,
    },
    productCounts: { total, active, ...bySource },
  };
}

export const GET = handle(async () => {
  const user = await requireUser("seller");
  return json({ settings: await loadSettings(user.id) });
});

export const PATCH = handle(async (req: Request) => {
  const user = await requireUser("seller");
  const body = await readJson(req, Body);
  const set: Partial<typeof sellerProfiles.$inferInsert> = {};
  if (body.displayName !== undefined) set.displayName = body.displayName;
  if (body.tagline !== undefined) set.tagline = body.tagline;
  if (body.autoDeal !== undefined) set.autoDeal = body.autoDeal;
  if (body.paypalMerchantId !== undefined) {
    const id = body.paypalMerchantId?.trim() || null;
    set.paypalMerchantId = id;
    set.onboardingStatus = id ? "complete" : "none";
  }
  if (Object.keys(set).length) {
    const db = await getDb();
    await db.update(sellerProfiles).set(set).where(eq(sellerProfiles.userId, user.id));
  }
  return json({ settings: await loadSettings(user.id) });
});
