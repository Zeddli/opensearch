// GET /api/paypal/onboard/return — PayPal redirects the seller here after onboarding.
// Query (from PayPal): merchantId (= our tracking_id = seller user id), merchantIdInPayPal,
// permissionsGranted, consentStatus, isEmailConfirmed, accountStatus.
// Verify with merchant-integrations (tracking_id must match) and store the merchant id.
// Without PayPal env: redirects with onboarded=0&error=paypal_not_configured.
// Always redirects to /seller/settings.
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, sellerProfiles } from "@/src/db";
import { getCurrentUser } from "@/src/lib/auth";
import { env } from "@/src/lib/env";
import { findMerchantIdByTrackingId, getMerchantIntegration, isPayPalConfigured, merchantReadiness } from "@/src/integrations/paypal";

export const dynamic = "force-dynamic";

const back = (q: string) => NextResponse.redirect(new URL(`/seller/settings?${q}`, env.APP_URL));

export async function GET(req: Request) {
  const url = new URL(req.url);
  const trackingId = url.searchParams.get("merchantId") ?? "";
  let merchantIdInPayPal = url.searchParams.get("merchantIdInPayPal") ?? "";
  if (!isPayPalConfigured()) return back("onboarded=0&error=paypal_not_configured");
  try {
    const db = await getDb();
    const current = await getCurrentUser();

    if (env.PAYPAL_PARTNER_MERCHANT_ID) {
      if (!merchantIdInPayPal && trackingId) merchantIdInPayPal = (await findMerchantIdByTrackingId(trackingId)) ?? "";
      if (!merchantIdInPayPal) return back("onboarded=0&error=missing_merchant_id");
      const mi = await getMerchantIntegration(merchantIdInPayPal);
      const sellerId = mi.tracking_id || trackingId;
      if (trackingId && mi.tracking_id && mi.tracking_id !== trackingId) return back("onboarded=0&error=tracking_mismatch");
      if (!sellerId) return back("onboarded=0&error=unknown_seller");
      const { ready, platformFeeGranted } = merchantReadiness(mi);
      await db
        .update(sellerProfiles)
        .set({ paypalMerchantId: mi.merchant_id || merchantIdInPayPal, onboardingStatus: ready ? "complete" : "pending", platformFeeEnabled: platformFeeGranted })
        .where(eq(sellerProfiles.userId, sellerId));
      return back(ready ? "onboarded=1" : "onboarded=pending");
    }

    // No partner merchant id configured → can't verify with PayPal; trust only the signed-in seller.
    console.warn("[paypal] onboard return without PAYPAL_PARTNER_MERCHANT_ID; storing unverified merchant id");
    if (!current || current.role !== "seller" || (trackingId && trackingId !== current.id)) return back("onboarded=0&error=not_signed_in");
    if (!merchantIdInPayPal) return back("onboarded=0&error=missing_merchant_id");
    await db
      .update(sellerProfiles)
      .set({
        paypalMerchantId: merchantIdInPayPal,
        onboardingStatus: url.searchParams.get("permissionsGranted") === "true" ? "complete" : "pending",
        platformFeeEnabled: url.searchParams.get("permissionsGranted") === "true",
      })
      .where(eq(sellerProfiles.userId, current.id));
    return back("onboarded=1");
  } catch (err) {
    console.error("[paypal] onboard return failed", err);
    return back("onboarded=0&error=paypal_error");
  }
}
