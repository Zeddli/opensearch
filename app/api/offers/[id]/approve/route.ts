// POST /api/offers/:id/approve — buyer clicked "Approve & pay".
// → {result:"paid", orderId, receipt} | {result:"needs_popup", paypalOrderId?}
// | 409 {result:"denied", reason, error}
// | 503 {error:'PayPal is not configured on this server'} when PayPal env is missing.
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { requirePayPal } from "@/src/integrations/paypal";
import { payForOffer } from "@/src/payments";

export const dynamic = "force-dynamic";

export const POST = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  requirePayPal();
  const user = await requireUser("buyer");
  const { id } = await params;
  const res = await payForOffer({ offerId: id, buyerId: user.id, userApproved: true });
  if (res.result === "denied") return json({ ...res, error: res.reason }, 409);
  return json(res);
});
