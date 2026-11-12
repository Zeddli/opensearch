// POST /api/paypal/vault/confirm {setupTokenId} → {vaultId} — after the buyer approved the setup token.
// 503 {error:'PayPal is not configured on this server'} when PayPal env is missing.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { buyerProfiles, getDb } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json, readJson } from "@/src/lib/http";
import { createPaymentTokenFromSetup, requirePayPal } from "@/src/integrations/paypal";

export const dynamic = "force-dynamic";
const Body = z.object({ setupTokenId: z.string().min(1) });

export const POST = handle(async (req: Request) => {
  requirePayPal();
  const user = await requireUser("buyer");
  const { setupTokenId } = await readJson(req, Body);
  const t = await createPaymentTokenFromSetup(setupTokenId);
  const db = await getDb();
  await db
    .update(buyerProfiles)
    .set({ paypalVaultId: t.vaultId, ...(t.customerId ? { paypalCustomerId: t.customerId } : {}) })
    .where(eq(buyerProfiles.userId, user.id));
  return json({ vaultId: t.vaultId });
});
