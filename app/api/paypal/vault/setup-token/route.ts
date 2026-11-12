// POST /api/paypal/vault/setup-token → {id, approveUrl}
// Vault v3 setup token for the JS SDK `createVaultSetupToken` callback (save PayPal without a purchase).
// 503 {error:'PayPal is not configured on this server'} when PayPal env is missing.
import { eq } from "drizzle-orm";
import { buyerProfiles, getDb } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { createSetupToken, requirePayPal } from "@/src/integrations/paypal";

export const dynamic = "force-dynamic";

export const POST = handle(async () => {
  requirePayPal();
  const user = await requireUser("buyer");
  const db = await getDb();
  const [p] = await db.select().from(buyerProfiles).where(eq(buyerProfiles.userId, user.id)).limit(1);
  const t = await createSetupToken({ buyerId: user.id, customerId: p?.paypalCustomerId ?? null });
  return json({ id: t.id, approveUrl: t.approveUrl });
});
