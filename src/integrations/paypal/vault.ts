// PayPal Vault v3: save a buyer's PayPal wallet without a purchase (setup token → payment token).
import { env } from "@/src/lib/env";
import { paypalFetch, PayPalError } from "./client";
import { VAULT_USAGE_TYPE, type PayPalLink } from "./orders";

export type SetupToken = { id: string; status: string; customer?: { id?: string }; links?: PayPalLink[] };
export type PaymentToken = { id: string; customer?: { id?: string }; payment_source?: { paypal?: { email_address?: string; payer_id?: string } } };

export async function createSetupToken(p: { buyerId: string; customerId?: string | null }): Promise<{ id: string; approveUrl: string | null }> {
  const body = (usageType: string) => ({
    ...(p.customerId ? { customer: { id: p.customerId } } : {}),
    payment_source: {
      paypal: {
        description: "OpenQuote: let your buying agent pay within your limits",
        usage_pattern: "IMMEDIATE",
        usage_type: usageType,
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          brand_name: "OpenQuote",
          shipping_preference: "NO_SHIPPING",
          return_url: `${env.APP_URL}/buyer/settings?paypal=linked`,
          cancel_url: `${env.APP_URL}/buyer/settings?paypal=cancel`,
        },
      },
    },
  });
  let token: SetupToken;
  try {
    token = await paypalFetch<SetupToken>("/v3/vault/setup-tokens", {
      method: "POST",
      body: body(VAULT_USAGE_TYPE),
      requestId: `setup-${p.buyerId}-${Date.now()}`,
    });
  } catch (err) {
    // PLATFORM usage may not be enabled for the sandbox app → fall back to MERCHANT.
    if (!(err instanceof PayPalError) || err.status >= 500 || VAULT_USAGE_TYPE === "MERCHANT") throw err;
    console.warn("[paypal] setup token with usage_type PLATFORM rejected; retrying with MERCHANT");
    token = await paypalFetch<SetupToken>("/v3/vault/setup-tokens", {
      method: "POST",
      body: body("MERCHANT"),
      requestId: `setup-m-${p.buyerId}-${Date.now()}`,
    });
  }
  const approveUrl = token.links?.find((l) => l.rel === "approve")?.href ?? null;
  return { id: token.id, approveUrl };
}

/** Exchange an approved setup token for a permanent payment token (vault id). */
export async function createPaymentTokenFromSetup(setupTokenId: string): Promise<{ vaultId: string; customerId: string | null; email: string | null }> {
  const t = await paypalFetch<PaymentToken>("/v3/vault/payment-tokens", {
    method: "POST",
    body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
    requestId: `ptoken-${setupTokenId}`,
  });
  return { vaultId: t.id, customerId: t.customer?.id ?? null, email: t.payment_source?.paypal?.email_address ?? null };
}

export async function deletePaymentToken(vaultId: string): Promise<void> {
  try {
    await paypalFetch(`/v3/vault/payment-tokens/${encodeURIComponent(vaultId)}`, { method: "DELETE" });
  } catch (err) {
    console.warn("[paypal] delete payment token failed (ignored):", (err as Error).message);
  }
}
