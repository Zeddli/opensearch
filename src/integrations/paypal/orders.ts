// PayPal Orders v2 (Multiparty: payee.merchant_id + optional platform_fees).
import { env } from "@/src/lib/env";
import { centsToValue, paypalFetch, PayPalError, valueToCents } from "./client";

export type PayPalLink = { href: string; rel: string; method?: string };

export type PayPalCapture = {
  id: string;
  status: string; // COMPLETED | PENDING | DECLINED | ...
  amount?: { currency_code: string; value: string };
  seller_receivable_breakdown?: { platform_fees?: Array<{ amount: { value: string } }> };
};

type VaultAttr = { id?: string; status?: string; customer?: { id?: string } };

export type PayPalOrder = {
  id: string;
  status: string; // CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED
  purchase_units?: Array<{
    reference_id?: string;
    amount?: { currency_code: string; value: string };
    payee?: { merchant_id?: string; email_address?: string };
    payments?: { captures?: PayPalCapture[] };
  }>;
  payment_source?: {
    paypal?: {
      email_address?: string;
      account_id?: string;
      // Docs show `attributes` in requests and `attribute` in some sample responses — handle both.
      attributes?: { vault?: VaultAttr };
      attribute?: { vault?: VaultAttr };
    };
  };
  links?: PayPalLink[];
};

export type CreateOrderInput = {
  offerId: string;
  amountCents: number;
  payeeMerchantId: string | null; // null → platform account receives (should not happen for marketplace)
  platformFeeCents: number; // 0 → no payment_instruction
  description?: string;
  /** Charge a saved PayPal wallet (buyer not present). */
  vaultId?: string;
  /** Save the buyer's PayPal wallet on successful capture (popup flow). */
  storeInVault?: boolean;
  /** Idempotency key. */
  requestId: string;
};

/** Vault usage type for Multiparty: PLATFORM lets the platform charge the wallet for any payee. Override with PAYPAL_VAULT_USAGE_TYPE=MERCHANT. */
export const VAULT_USAGE_TYPE = ((process.env.PAYPAL_VAULT_USAGE_TYPE ?? "").trim().toUpperCase() || "PLATFORM") as
  | "PLATFORM"
  | "MERCHANT";

export function buildOrderBody(i: CreateOrderInput) {
  const amount = { currency_code: "USD", value: centsToValue(i.amountCents) };
  const pu: Record<string, unknown> = {
    reference_id: i.offerId,
    custom_id: i.offerId,
    description: i.description?.slice(0, 127),
    amount,
  };
  if (i.payeeMerchantId) pu.payee = { merchant_id: i.payeeMerchantId };
  if (i.platformFeeCents > 0) {
    pu.payment_instruction = {
      disbursement_mode: "INSTANT",
      platform_fees: [{ amount: { currency_code: "USD", value: centsToValue(i.platformFeeCents) } }],
    };
  }
  const body: Record<string, unknown> = { intent: "CAPTURE", purchase_units: [pu] };
  if (i.vaultId) {
    body.payment_source = { paypal: { vault_id: i.vaultId } };
  } else if (i.storeInVault) {
    body.payment_source = {
      paypal: {
        attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: VAULT_USAGE_TYPE, customer_type: "CONSUMER" } },
        experience_context: {
          brand_name: "OpenQuote",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: `${env.APP_URL}/buyer/settings?paypal=return`,
          cancel_url: `${env.APP_URL}/buyer/settings?paypal=cancel`,
        },
      },
    };
  }
  return body;
}

export async function createPayPalOrder(i: CreateOrderInput): Promise<PayPalOrder> {
  return paypalFetch<PayPalOrder>("/v2/checkout/orders", { method: "POST", body: buildOrderBody(i), requestId: i.requestId });
}

/**
 * Create an order, degrading gracefully:
 *  1. if PayPal rejects the vault attributes → retry without saving the wallet
 *  2. if PayPal rejects the platform fee → retry without platform_fees (fee recorded as 0)
 * Returns the order and the fee that was actually applied.
 */
export async function createOrderWithFallbacks(
  i: CreateOrderInput,
): Promise<{ order: PayPalOrder; platformFeeCents: number; storeInVault: boolean }> {
  let cur = { ...i };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const order = await createPayPalOrder({ ...cur, requestId: `${i.requestId}-${attempt}` });
      return { order, platformFeeCents: cur.platformFeeCents, storeInVault: Boolean(cur.storeInVault) };
    } catch (err) {
      const retryable = err instanceof PayPalError && err.status >= 400 && err.status < 500 && err.status !== 401;
      if (!retryable) throw err;
      if (cur.storeInVault) {
        console.warn("[paypal] order create rejected with vault attributes; retrying without vault:", (err as Error).message);
        cur = { ...cur, storeInVault: false };
        continue;
      }
      if (cur.platformFeeCents > 0) {
        console.warn("[paypal] order create rejected with platform fee; retrying without fee (recorded as 0):", (err as Error).message);
        cur = { ...cur, platformFeeCents: 0 };
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

export async function getPayPalOrder(paypalOrderId: string): Promise<PayPalOrder> {
  return paypalFetch<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { method: "GET" });
}

/** Capture an approved order. Idempotent: already-captured orders are re-read and returned. */
export async function capturePayPalOrder(paypalOrderId: string): Promise<PayPalOrder> {
  try {
    return await paypalFetch<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: "POST",
      body: {},
      requestId: `capture-${paypalOrderId}`,
    });
  } catch (err) {
    if (err instanceof PayPalError && err.hasIssue("ORDER_ALREADY_CAPTURED")) return getPayPalOrder(paypalOrderId);
    throw err;
  }
}

export function firstCapture(o: PayPalOrder): PayPalCapture | null {
  return o.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}

export function vaultFromOrder(o: PayPalOrder): { vaultId: string | null; customerId: string | null } {
  const v = o.payment_source?.paypal?.attributes?.vault ?? o.payment_source?.paypal?.attribute?.vault;
  return { vaultId: v?.id ?? null, customerId: v?.customer?.id ?? null };
}

export type OrderStatusSummary = {
  paypalOrderId: string;
  status: string;
  amountCents: number;
  referenceId: string | null;
  payeeMerchantId: string | null;
  captureId: string | null;
  captureStatus: string | null;
};

export function summarizeOrder(o: PayPalOrder): OrderStatusSummary {
  const pu = o.purchase_units?.[0];
  const cap = firstCapture(o);
  return {
    paypalOrderId: o.id,
    status: o.status,
    amountCents: valueToCents(cap?.amount?.value ?? pu?.amount?.value),
    referenceId: pu?.reference_id ?? null,
    payeeMerchantId: pu?.payee?.merchant_id ?? null,
    captureId: cap?.id ?? null,
    captureStatus: cap?.status ?? null,
  };
}
