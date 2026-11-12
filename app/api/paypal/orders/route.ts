// POST /api/paypal/orders {offerId} → {id} — createOrder callback for the PayPal JS SDK button.
// 503 {error:'PayPal is not configured on this server'} when PayPal env is missing.
import { z } from "zod";
import { requireUser } from "@/src/lib/auth";
import { handle, json, readJson } from "@/src/lib/http";
import { requirePayPal } from "@/src/integrations/paypal";
import { createPopupOrder } from "@/src/payments";

export const dynamic = "force-dynamic";
const Body = z.object({ offerId: z.string().min(1) });

export const POST = handle(async (req: Request) => {
  requirePayPal();
  const user = await requireUser("buyer");
  const { offerId } = await readJson(req, Body);
  return json(await createPopupOrder({ offerId, buyerId: user.id }));
});
