// POST /api/shopify/connect {domain, token} → {connected:true, domain, shopName}
//   Validates against the real store with Admin GraphQL `shop { name }`, stores the token
//   encrypted (src/lib/secrets.ts).
// DELETE /api/shopify/connect → {connected:false}
import { z } from "zod";
import { connectShopify, disconnectShopify, ShopifyError } from "@/src/integrations/shopify";
import { requireUser } from "@/src/lib/auth";
import { handle, HttpError, json, readJson } from "@/src/lib/http";

const Body = z.object({
  domain: z.string().trim().min(1, "Store domain is required").max(255),
  token: z.string().trim().min(1, "Access token is required").max(500),
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser("seller");
  const body = await readJson(req, Body);
  try {
    const res = await connectShopify(user.id, body);
    return json({ connected: true, ...res });
  } catch (err) {
    if (err instanceof ShopifyError) {
      const status = err.status === 400 ? 400 : err.status === 401 || err.status === 403 || err.status === 404 ? 400 : 502;
      throw new HttpError(status, err.message);
    }
    throw err;
  }
});

export const DELETE = handle(async () => {
  const user = await requireUser("seller");
  await disconnectShopify(user.id);
  return json({ connected: false });
});
