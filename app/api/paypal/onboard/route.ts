// POST /api/paypal/onboard → {actionUrl}
// Partner Referrals → PayPal-hosted onboarding URL (returns to /api/paypal/onboard/return).
// 503 {error:'PayPal is not configured on this server'} when PayPal env is missing.
import { eq } from "drizzle-orm";
import { getDb, sellerProfiles } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { createPartnerReferral, requirePayPal } from "@/src/integrations/paypal";

export const dynamic = "force-dynamic";

export const POST = handle(async () => {
  requirePayPal();
  const user = await requireUser("seller");
  const { actionUrl } = await createPartnerReferral({ trackingId: user.id, email: user.email });
  const db = await getDb();
  await db.update(sellerProfiles).set({ onboardingStatus: "pending" }).where(eq(sellerProfiles.userId, user.id));
  return json({ actionUrl });
});
