// POST /api/paypal/webhook — PayPal webhook receiver (no auth cookie; verified by signature).
// Verifies via /v1/notifications/verify-webhook-signature when PAYPAL_WEBHOOK_ID is set.
// Without it, events are still never trusted blindly: captures are re-read from PayPal Orders v2,
// onboarding is re-checked via merchant-integrations. Idempotent per event id (agent_events log).
import { and, eq, sql } from "drizzle-orm";
import { agentEvents, getDb, sellerProfiles } from "@/src/db";
import { env } from "@/src/lib/env";
import { handle, json } from "@/src/lib/http";
import { getMerchantIntegration, isPayPalConfigured, merchantReadiness, PAYPAL_WEBHOOK_ID, verifyWebhookSignature } from "@/src/integrations/paypal";
import { handleCaptureCompleted, handleCaptureDenied } from "@/src/payments";

export const dynamic = "force-dynamic";

type WebhookEvent = {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    merchant_id?: string;
    tracking_id?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
};

export const POST = handle(async (req: Request) => {
  const raw = await req.text();
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw) as WebhookEvent;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!isPayPalConfigured()) return json({ error: "PayPal is not configured on this server" }, 503);

  if (PAYPAL_WEBHOOK_ID) {
    const ok = await verifyWebhookSignature(req.headers, event).catch((err) => {
      console.error("[paypal] webhook verification error", err);
      return false;
    });
    if (!ok) return json({ error: "Invalid webhook signature" }, 400);
  } else {
    console.warn("[paypal] PAYPAL_WEBHOOK_ID not set; webhook signature not verified (state is re-checked with PayPal)");
  }

  const eventId = event.id ?? "";
  const type = event.event_type ?? "unknown";
  const db = await getDb();
  if (eventId) {
    const seen = await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(and(eq(agentEvents.actor, "paypal_webhook"), sql`${agentEvents.input}->>'eventId' = ${eventId}`))
      .limit(1);
    if (seen.length) return json({ ok: true, duplicate: true });
  }

  let outcome = "ignored";
  const r = event.resource ?? {};
  try {
    switch (type) {
      case "PAYMENT.CAPTURE.COMPLETED": {
        const orderId = r.supplementary_data?.related_ids?.order_id;
        if (orderId) outcome = await handleCaptureCompleted(orderId);
        break;
      }
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.DECLINED": {
        const orderId = r.supplementary_data?.related_ids?.order_id;
        if (orderId) outcome = await handleCaptureDenied(orderId);
        break;
      }
      case "MERCHANT.ONBOARDING.COMPLETED":
      case "MERCHANT.PARTNER-CONSENT.REVOKED": {
        const sellerId = r.tracking_id;
        const merchantId = r.merchant_id;
        if (!sellerId || !merchantId) break;
        if (type === "MERCHANT.PARTNER-CONSENT.REVOKED") {
          await db.update(sellerProfiles).set({ onboardingStatus: "none", platformFeeEnabled: false, paypalMerchantId: null }).where(eq(sellerProfiles.userId, sellerId));
          outcome = "revoked";
          break;
        }
        let ready = true;
        let fee = false;
        if (env.PAYPAL_PARTNER_MERCHANT_ID) {
          const mi = await getMerchantIntegration(merchantId);
          if (mi.tracking_id && mi.tracking_id !== sellerId) break;
          ({ ready, platformFeeGranted: fee } = merchantReadiness(mi));
        } else if (!PAYPAL_WEBHOOK_ID) {
          break; // can't verify either way → ignore
        }
        await db
          .update(sellerProfiles)
          .set({ paypalMerchantId: merchantId, onboardingStatus: ready ? "complete" : "pending", platformFeeEnabled: fee })
          .where(eq(sellerProfiles.userId, sellerId));
        outcome = ready ? "complete" : "pending";
        break;
      }
    }
  } catch (err) {
    console.error("[paypal] webhook handling failed", type, err);
    return json({ error: "Webhook handling failed" }, 500); // PayPal retries
  }

  await db.insert(agentEvents).values({ actor: "paypal_webhook", tool: type, input: { eventId, resourceId: r.id ?? null }, output: { outcome }, decision: outcome });
  return json({ ok: true, outcome });
});
