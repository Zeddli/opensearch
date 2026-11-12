// Shopify integration (CONTRACTS §6, architecture §8). Owned by INTEGRATIONS.
//
// Per-seller connection to a real store only: seller_profiles.shopify_domain + shopify_token_enc
// (encrypted with encryptSecret from src/lib/secrets.ts, key = APP_ENCRYPTION_KEY).
// Admin GraphQL API at https://{domain}/admin/api/{SHOPIFY_API_VERSION}/graphql.json with
// `X-Shopify-Access-Token`. The "token" may be an Admin API access token (shpat_…, legacy custom
// app / OAuth offline token) OR `clientId:clientSecret` of a Dev Dashboard app installed on a
// store in the same org — we then exchange it via the client-credentials grant
// (POST /admin/oauth/access_token, 24h tokens, cached).
// Scopes needed: read_products, read_inventory, write_orders.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, offers, orders, products, sellerProfiles, type NewProduct } from "@/src/db";
import { decryptSecret, encryptSecret } from "@/src/lib/secrets";

export const SHOPIFY_API_VERSION = "2026-10"; // latest stable per shopify.dev/docs/api/usage/versioning (Nov 2026)
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Token encryption (shared app secret store)
// ---------------------------------------------------------------------------

export const encryptToken = (plain: string): string => encryptSecret(plain);

/** null when the value is malformed or was encrypted with a different APP_ENCRYPTION_KEY. */
export function decryptToken(enc: string): string | null {
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Domain + connection helpers
// ---------------------------------------------------------------------------

/** "https://My-Store.myshopify.com/admin" → "my-store.myshopify.com"; "my-store" → "my-store.myshopify.com". */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (!d) return null;
  if (!d.includes(".")) d = `${d}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) return null;
  return d;
}

export type ShopifyConnection = { domain: string; token: string };

export async function getConnection(sellerId: string): Promise<ShopifyConnection | null> {
  const db = await getDb();
  const [p] = await db
    .select({ domain: sellerProfiles.shopifyDomain, enc: sellerProfiles.shopifyTokenEnc })
    .from(sellerProfiles)
    .where(eq(sellerProfiles.userId, sellerId))
    .limit(1);
  if (!p?.domain || !p.enc) return null;
  const token = decryptToken(p.enc);
  if (token == null) {
    console.error(`[shopify] could not decrypt token for seller ${sellerId} (APP_ENCRYPTION_KEY changed?); seller must reconnect`);
    return null;
  }
  return { domain: p.domain, token };
}

// ---------------------------------------------------------------------------
// Admin GraphQL client
// ---------------------------------------------------------------------------

export class ShopifyError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

const g = globalThis as unknown as { __aaShopifyTokens?: Map<string, { token: string; exp: number }> };
const ccCache: Map<string, { token: string; exp: number }> = (g.__aaShopifyTokens ??= new Map());

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } catch (err) {
    throw new ShopifyError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the stored credential to an Admin API access token. */
async function accessToken(domain: string, credential: string): Promise<string> {
  const c = credential.trim();
  // Access tokens are shpat_/shpca_/shpss_… or opaque; client credentials are "id:secret".
  const m = c.match(/^([^:\s]{8,}):([^:\s]{8,})$/);
  if (!m || /^shp[a-z]{2}_/.test(c)) return c;
  const cacheKey = `${domain}|${createHash("sha256").update(c).digest("hex")}`;
  const hit = ccCache.get(cacheKey);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const res = await fetchWithTimeout(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: m[1], client_secret: m[2] }),
  });
  const text = await res.text();
  if (!res.ok) throw new ShopifyError(`Client-credentials exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
  const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new ShopifyError("Client-credentials exchange returned no access_token");
  ccCache.set(cacheKey, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 86_399) * 1000 });
  return data.access_token;
}

export async function shopifyGraphql<T>(
  conn: { domain: string; token: string },
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await accessToken(conn.domain, conn.token);
  const res = await fetchWithTimeout(`https://${conn.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 ? " (invalid access token)" : res.status === 403 ? " (missing scope)" : "";
    throw new ShopifyError(`Shopify HTTP ${res.status}${hint}: ${text.slice(0, 200)}`, res.status);
  }
  const body = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> | string };
  if (body.errors) {
    const msg = typeof body.errors === "string" ? body.errors : body.errors.map((e) => e.message).join("; ");
    throw new ShopifyError(`Shopify GraphQL error: ${msg}`);
  }
  if (!body.data) throw new ShopifyError("Shopify returned no data");
  return body.data;
}

// ---------------------------------------------------------------------------
// Connect (used by POST /api/shopify/connect)
// ---------------------------------------------------------------------------

/** Validate credentials against the real store (`shop { name }`), then store domain + encrypted token. */
export async function connectShopify(
  sellerId: string,
  input: { domain: string; token: string },
): Promise<{ domain: string; shopName: string }> {
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new ShopifyError("Enter your store's myshopify.com domain, e.g. my-store.myshopify.com", 400);
  const token = input.token.trim();
  if (!token) throw new ShopifyError("Access token is required", 400);
  const data = await shopifyGraphql<{ shop: { name: string } }>({ domain, token }, "query { shop { name } }");
  const shopName = data.shop.name;
  const db = await getDb();
  await db
    .update(sellerProfiles)
    .set({ shopifyDomain: domain, shopifyTokenEnc: encryptToken(token) })
    .where(eq(sellerProfiles.userId, sellerId));
  return { domain, shopName };
}

export async function disconnectShopify(sellerId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(sellerProfiles)
    .set({ shopifyDomain: null, shopifyTokenEnc: null })
    .where(eq(sellerProfiles.userId, sellerId));
}

// ---------------------------------------------------------------------------
// Catalog import
// ---------------------------------------------------------------------------

type ImportedVariant = {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  description: string;
  category: string;
  unitPriceCents: number;
  stock: number;
  moq?: number;
  leadTimeDays?: number;
  imageUrl: string | null;
  attributes: Record<string, unknown>;
};

const PRODUCTS_QUERY = `
query ImportProducts($cursor: String) {
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      description
      productType
      vendor
      handle
      featuredMedia { preview { image { url } } }
      variants(first: 50) {
        nodes { id title sku price inventoryQuantity selectedOptions { name value } }
      }
    }
  }
}`;

type ProductsPage = {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      title: string;
      description: string | null;
      productType: string | null;
      vendor: string | null;
      handle: string;
      featuredMedia: { preview?: { image?: { url?: string } | null } | null } | null;
      variants: {
        nodes: Array<{
          id: string;
          title: string;
          sku: string | null;
          price: string;
          inventoryQuantity: number | null;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    }>;
  };
};

async function fetchLiveCatalog(conn: ShopifyConnection): Promise<ImportedVariant[]> {
  const out: ImportedVariant[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data: ProductsPage = await shopifyGraphql<ProductsPage>(conn, PRODUCTS_QUERY, { cursor });
    for (const p of data.products.nodes) {
      for (const v of p.variants.nodes) {
        const unitPriceCents = Math.round(Number.parseFloat(v.price) * 100);
        if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) continue;
        const variantLabel = v.title && v.title !== "Default Title" ? ` — ${v.title}` : "";
        out.push({
          shopifyProductId: p.id,
          shopifyVariantId: v.id,
          title: `${p.title}${variantLabel}`,
          description: (p.description ?? "").slice(0, 2000),
          category: (p.productType || "general").toLowerCase(),
          unitPriceCents,
          stock: Math.max(0, v.inventoryQuantity ?? 0),
          imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
          attributes: {
            vendor: p.vendor ?? undefined,
            sku: v.sku ?? undefined,
            handle: p.handle,
            ...Object.fromEntries(
              v.selectedOptions.filter((o) => o.name !== "Title").map((o) => [o.name.toLowerCase(), o.value]),
            ),
          },
        });
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return out;
}

/** Import the seller's Shopify catalog into `products`; returns number imported (inserted + updated). */
export async function importShopifyCatalog(sellerId: string): Promise<number> {
  const conn = await getConnection(sellerId);
  if (!conn) return 0;
  const items = await fetchLiveCatalog(conn);
  const db = await getDb();
  let count = 0;
  for (const it of items) {
    const [existing] = await db
      .select()
      .from(products)
      .where(and(eq(products.sellerId, sellerId), eq(products.shopifyVariantId, it.shopifyVariantId)))
      .limit(1);
    if (existing) {
      // Refresh catalog data; keep the seller's guardrails (clamp floor if the price dropped below it).
      await db
        .update(products)
        .set({
          title: it.title,
          description: it.description,
          unitPriceCents: it.unitPriceCents,
          stock: it.stock,
          imageUrl: it.imageUrl ?? existing.imageUrl,
          shopifyProductId: it.shopifyProductId,
          attributes: { ...existing.attributes, ...it.attributes },
          floorPriceCents: Math.min(existing.floorPriceCents, it.unitPriceCents),
        })
        .where(eq(products.id, existing.id));
    } else {
      const row: NewProduct = {
        sellerId,
        source: "shopify",
        title: it.title,
        description: it.description,
        category: it.category,
        unitPriceCents: it.unitPriceCents,
        stock: it.stock,
        moq: it.moq ?? 1,
        leadTimeDays: it.leadTimeDays ?? 3,
        attributes: it.attributes,
        floorPriceCents: Math.round(it.unitPriceCents * 0.85),
        maxDiscountPct: 15,
        imageUrl: it.imageUrl,
        shopifyProductId: it.shopifyProductId,
        shopifyVariantId: it.shopifyVariantId,
        active: true,
      };
      await db.insert(products).values(row);
    }
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Order write-back
// ---------------------------------------------------------------------------

const ORDER_CREATE = `
mutation OpenQuoteOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name }
    userErrors { field message }
  }
}`;

const money = (cents: number) => ({ shopMoney: { amount: (cents / 100).toFixed(2), currencyCode: "USD" } });

/** Write a paid order back to Shopify; returns the Shopify order id, or null (non-Shopify product / not connected / error). */
export async function createShopifyOrder(orderId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ order: orders, offer: offers, product: products })
      .from(orders)
      .innerJoin(offers, eq(offers.id, orders.offerId))
      .innerJoin(products, eq(products.id, offers.productId))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row) return null;
    const { order, offer, product } = row;
    if (order.shopifyOrderId) return order.shopifyOrderId; // idempotent
    if (product.source !== "shopify" || !product.shopifyVariantId) return null;
    const conn = await getConnection(product.sellerId);
    if (!conn) return null;

    {
      const paidVia = `PayPal order ${order.paypalOrderId ?? "(vault)"}`;
      const note = `OpenQuote order ${order.id} · ${paidVia} · offer ${offer.id}`;
      const data = await shopifyGraphql<{
        orderCreate: { order: { id: string; name: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(conn, ORDER_CREATE, {
        order: {
          lineItems: [
            { variantId: product.shopifyVariantId, quantity: offer.quantity, priceSet: money(offer.unitPriceCents) },
          ],
          ...(offer.shippingCents > 0
            ? { shippingLines: [{ title: "OpenQuote negotiated shipping", priceSet: money(offer.shippingCents) }] }
            : {}),
          financialStatus: "PAID",
          currency: "USD",
          note,
          tags: ["openquote", "paypal"],
          sourceIdentifier: order.id,
        },
        options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false },
      });
      const errs = data.orderCreate.userErrors;
      if (errs.length || !data.orderCreate.order) {
        console.error("[shopify] orderCreate userErrors", errs);
        return null;
      }
      const shopifyOrderId = data.orderCreate.order.id;
      await db.update(orders).set({ shopifyOrderId }).where(eq(orders.id, orderId));
      return shopifyOrderId;
    }
  } catch (err) {
    console.error(`[shopify] createShopifyOrder(${orderId}) failed`, err);
    return null;
  }
}
