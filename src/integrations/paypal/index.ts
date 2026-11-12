// PayPal integration (PAYMENTS). Server-only. Disabled (never faked) unless PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET are set.
export * from "./client";
export * from "./orders";
export * from "./vault";
export * from "./partners";
export * from "./webhooks";

import { isPayPalConfigured } from "./client";
import { getPayPalOrder, summarizeOrder, type OrderStatusSummary } from "./orders";

/**
 * Read-only order status straight from PayPal (for the buyer agent). Returns null when PayPal
 * is not configured or can't find it. For a DB-aware version (accepts our order id)
 * use `getOrderStatus` from "@/src/payments".
 */
export async function getPayPalOrderStatus(paypalOrderId: string): Promise<OrderStatusSummary | null> {
  if (!isPayPalConfigured()) return null;
  try {
    return summarizeOrder(await getPayPalOrder(paypalOrderId));
  } catch {
    return null;
  }
}
