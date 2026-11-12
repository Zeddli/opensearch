// POST /api/shopify/import → {imported}
// Upserts the connected store's products/variants into `products` (source 'shopify').
import { getConnection, importShopifyCatalog, ShopifyError } from "@/src/integrations/shopify";
import { requireUser } from "@/src/lib/auth";
import { badRequest, handle, HttpError, json } from "@/src/lib/http";

export const POST = handle(async () => {
  const user = await requireUser("seller");
  if (!(await getConnection(user.id))) throw badRequest("Connect your Shopify store first");
  try {
    const imported = await importShopifyCatalog(user.id);
    return json({ imported });
  } catch (err) {
    if (err instanceof ShopifyError) throw new HttpError(502, err.message);
    throw err;
  }
});
