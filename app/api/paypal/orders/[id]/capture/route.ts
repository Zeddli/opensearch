// POST /api/paypal/orders/:id/capture {offerId} → {orderId, receipt} — onApprove callback.
// 503 {error:'PayPal is not configured on this server'} when PayPal env is missing.
import { z } from "zod";
import { requireUser } from "@/src/lib/auth";
import { handle, json, readJson } from "@/src/lib/http";
import { requirePayPal } from "@/src/integrations/paypal";
import { capturePopupOrder } from "@/src/payments";

export const dynamic = "force-dynamic";
const Body = z.object({ offerId: z.string().min(1) });

export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  requirePayPal();
  const user = await requireUser("buyer");
  const { id } = await params;
  const { offerId } = await readJson(req, Body);
  return json(await capturePopupOrder({ paypalOrderId: id, offerId, buyerId: user.id }));
});
