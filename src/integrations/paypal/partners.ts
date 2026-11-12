// Partner Referrals (seller onboarding) + merchant-integrations status.
import { env } from "@/src/lib/env";
import { paypalFetch } from "./client";
import type { PayPalLink } from "./orders";

/** Create a partner referral; returns the PayPal-hosted onboarding URL. trackingId = our seller user id. */
export async function createPartnerReferral(p: { trackingId: string; email?: string }): Promise<{ actionUrl: string }> {
  const res = await paypalFetch<{ links?: PayPalLink[] }>("/v2/customer/partner-referrals", {
    method: "POST",
    requestId: `referral-${p.trackingId}-${Date.now()}`,
    body: {
      ...(p.email ? { email: p.email } : {}),
      tracking_id: p.trackingId,
      partner_config_override: {
        return_url: `${env.APP_URL}/api/paypal/onboard/return`,
        return_url_description: "Back to OpenQuote seller settings",
      },
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              third_party_details: { features: ["PAYMENT", "REFUND", "PARTNER_FEE"] },
            },
          },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    },
  });
  const actionUrl = res.links?.find((l) => l.rel === "action_url")?.href;
  if (!actionUrl) throw new Error("PayPal partner referral returned no action_url");
  return { actionUrl };
}

export type MerchantIntegration = {
  merchant_id: string;
  tracking_id?: string;
  payments_receivable?: boolean;
  primary_email_confirmed?: boolean;
  oauth_integrations?: Array<{ integration_type?: string; oauth_third_party?: Array<{ scopes?: string[] }> }>;
  products?: Array<{ name?: string; vetting_status?: string; capabilities?: string[] }>;
};

export async function getMerchantIntegration(merchantId: string): Promise<MerchantIntegration> {
  if (!env.PAYPAL_PARTNER_MERCHANT_ID) throw new Error("PAYPAL_PARTNER_MERCHANT_ID is not set (needed for merchant-integrations)");
  return paypalFetch<MerchantIntegration>(
    `/v1/customer/partners/${encodeURIComponent(env.PAYPAL_PARTNER_MERCHANT_ID)}/merchant-integrations/${encodeURIComponent(merchantId)}`,
    { method: "GET" },
  );
}

/** Look up a seller's merchant id by our tracking id (if the return URL lacked merchantIdInPayPal). */
export async function findMerchantIdByTrackingId(trackingId: string): Promise<string | null> {
  if (!env.PAYPAL_PARTNER_MERCHANT_ID) return null;
  const res = await paypalFetch<{ merchant_id?: string }>(
    `/v1/customer/partners/${encodeURIComponent(env.PAYPAL_PARTNER_MERCHANT_ID)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`,
    { method: "GET" },
  );
  return res.merchant_id ?? null;
}

/** Summarize readiness: can receive payments, and whether the platform-fee permission was granted. */
export function merchantReadiness(m: MerchantIntegration): { ready: boolean; platformFeeGranted: boolean } {
  const scopes = (m.oauth_integrations ?? []).flatMap((o) => (o.oauth_third_party ?? []).flatMap((t) => t.scopes ?? []));
  return {
    ready: Boolean(m.payments_receivable && m.primary_email_confirmed),
    platformFeeGranted: scopes.some((s) => s.toLowerCase().includes("partnerfee")),
  };
}
