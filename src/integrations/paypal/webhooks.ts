// Webhook signature verification via /v1/notifications/verify-webhook-signature.
import { paypalFetch } from "./client";

export const PAYPAL_WEBHOOK_ID = (process.env.PAYPAL_WEBHOOK_ID ?? "").trim();

export async function verifyWebhookSignature(headers: Headers, event: unknown): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID) return false;
  const h = (k: string) => headers.get(k) ?? "";
  const res = await paypalFetch<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    partnerAttribution: false,
    representation: false,
    body: {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    },
  });
  return res.verification_status === "SUCCESS";
}
