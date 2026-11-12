// GET/PATCH /api/buyer/settings — agent spend limits + PayPal link state.
// paypalLinked/autoPayEnabled = a saved PayPal wallet the agent can charge under the limit (PayPal configured).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { buyerProfiles, getDb, type BuyerProfile } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json, notFound, readJson } from "@/src/lib/http";
import { deletePaymentToken, isPayPalConfigured } from "@/src/integrations/paypal";
import { buyerHasAutoPay } from "@/src/policy";

export const dynamic = "force-dynamic";

async function load(userId: string): Promise<BuyerProfile> {
  const db = await getDb();
  const [p] = await db.select().from(buyerProfiles).where(eq(buyerProfiles.userId, userId)).limit(1);
  if (!p) throw notFound("Buyer profile not found");
  return p;
}

function view(p: BuyerProfile) {
  const paypal = isPayPalConfigured();
  const autoPayEnabled = paypal && buyerHasAutoPay(p);
  return {
    autoPayLimitCents: p.autoPayLimitCents,
    monthlyCapCents: p.monthlyCapCents,
    spentThisMonthCents: p.spentThisMonthCents,
    remainingThisMonthCents: Math.max(0, p.monthlyCapCents - p.spentThisMonthCents),
    paypalLinked: autoPayEnabled,
    autoPayEnabled,
    paypal: paypal ? ("configured" as const) : ("missing" as const),
  };
}

export const GET = handle(async () => {
  const user = await requireUser("buyer");
  return json(view(await load(user.id)));
});

const MAX = 100_000_000; // $1M
const Patch = z.object({
  autoPayLimitCents: z.number().int().min(0).max(MAX).optional(),
  monthlyCapCents: z.number().int().min(0).max(MAX).optional(),
  /** true → forget the saved PayPal wallet (agent can no longer auto-pay). */
  unlinkPaypal: z.boolean().optional(),
});

export const PATCH = handle(async (req: Request) => {
  const user = await requireUser("buyer");
  const body = await readJson(req, Patch);
  const current = await load(user.id);
  const set: Partial<typeof buyerProfiles.$inferInsert> = {};
  if (body.autoPayLimitCents !== undefined) set.autoPayLimitCents = body.autoPayLimitCents;
  if (body.monthlyCapCents !== undefined) set.monthlyCapCents = body.monthlyCapCents;
  if (body.unlinkPaypal) {
    if (isPayPalConfigured() && current.paypalVaultId) {
      // Forget locally even if PayPal already dropped (or never knew) the token.
      await deletePaymentToken(current.paypalVaultId).catch((err) => console.warn("[buyer] could not delete PayPal payment token", err));
    }
    set.paypalVaultId = null;
  }
  if (Object.keys(set).length) {
    const db = await getDb();
    await db.update(buyerProfiles).set(set).where(eq(buyerProfiles.userId, user.id));
  }
  return json(view(await load(user.id)));
});
