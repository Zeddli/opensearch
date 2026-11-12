// Channel3 market search (CONTRACTS §6, architecture §7). Owned by INTEGRATIONS.
//
// Requires CHANNEL3_API_KEY (platform operator credential): POST https://api.trychannel3.com/v1/search with `x-api-key`.
//   Response: { products: [{ id, title, brands:[{name}], images:[{url,is_main_image}],
//               offers:[{ url, domain, price:{price, compare_at_price, currency}, availability }] }],
//               next_page_token }
// Without a key the feature is disabled: searchMarket returns [] and callers should show
// CHANNEL3_UNAVAILABLE_NOTE ("Public-web comparison unavailable (Channel3 not configured)").
//
// Retail listings are normalised to the buyer's bulk quantity: if the title implies a pack
// ("Pack of 50", "1000 count", "case of 500") we buy whole packs:
//   priceCents    = per-unit price (pack price / pack size, rounded)
//   estTotalCents = ceil(quantity / packSize) * packPrice
// `raw` keeps the listing's own price + detected pack size.
// Never throws: returns [] on error (logged). Results cached in memory for 1h per query hash.
import { createHash } from "node:crypto";
import { env } from "@/src/lib/env";

export type MarketResult = {
  title: string;
  merchant: string;
  priceCents: number;
  estTotalCents: number;
  url: string;
  imageUrl: string | null;
  raw: unknown;
};

type Query = { query: string; quantity: number; maxTotalCents?: number; limit?: number };

const CHANNEL3_URL = "https://api.trychannel3.com/v1/search";
const CACHE_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 12_000;

type CacheEntry = { at: number; results: MarketResult[] };
const g = globalThis as unknown as { __aaChannel3Cache?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = (g.__aaChannel3Cache ??= new Map());

/** True when the platform operator configured CHANNEL3_API_KEY. */
export const isChannel3Configured = (): boolean => Boolean(env.CHANNEL3_API_KEY);

/** Text for the buyer analysis when public-web comparison is disabled. */
export const CHANNEL3_UNAVAILABLE_NOTE = "Public-web comparison unavailable (Channel3 not configured)";

export async function searchMarket(q: Query): Promise<MarketResult[]> {
  try {
    if (!isChannel3Configured()) return [];
    const query = (q.query ?? "").trim();
    if (!query) return [];
    const quantity = Math.max(1, Math.floor(Number(q.quantity) || 1));
    const limit = Math.min(30, Math.max(1, Math.floor(q.limit ?? 8)));
    const key = createHash("sha256")
      .update(JSON.stringify([query.toLowerCase(), quantity, q.maxTotalCents ?? null, limit]))
      .digest("hex");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

    const results = await liveSearch(query, quantity, limit, q.maxTotalCents);
    // Only cache non-empty results so a transient API failure isn't pinned for an hour.
    if (results.length) cache.set(key, { at: Date.now(), results });
    return results;
  } catch (err) {
    console.error("[channel3] searchMarket failed", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pack-size normalisation
// ---------------------------------------------------------------------------

/** Detect how many units one listing contains from its title (1 if no pack implied). */
export function detectPackSize(title: string): number {
  const t = title.toLowerCase().replace(/(\d),(\d{3})/g, "$1$2");
  const patterns = [
    /\b(?:pack|case|box|set|bag|sleeve|carton|lot|bundle)\s+of\s+(\d{1,6})\b/,
    /\b(\d{1,6})\s*(?:-|\s)?\s*(?:pack|pk|count|ct|pcs|pieces|piece|units|per case|\/case|\/pack|bulk)\b/,
    /\b(\d{1,6})\s+(?:cups|lids|bags|boxes|sleeves|straws|napkins|carriers|containers|bottles|cans)\b/,
  ];
  let best = 1;
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (n > best && n <= 100_000) best = n;
    }
  }
  return best;
}

function normalise(listedPriceCents: number, title: string, quantity: number) {
  const packSize = detectPackSize(title);
  const packs = Math.ceil(quantity / packSize);
  return {
    packSize,
    packs,
    priceCents: Math.max(1, Math.round(listedPriceCents / packSize)),
    estTotalCents: packs * listedPriceCents,
  };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

type C3Offer = {
  url?: string;
  domain?: string;
  price?: { price?: number; compare_at_price?: number | null; currency?: string };
  availability?: string;
  condition?: string;
};
type C3Product = {
  id?: string;
  title?: string;
  brands?: Array<{ id?: string; name?: string }>;
  images?: Array<{ url?: string; is_main_image?: boolean }>;
  offers?: C3Offer[];
};

const MERCHANT_NAMES: Record<string, string> = {
  "amazon.com": "Amazon",
  "walmart.com": "Walmart",
  "webstaurantstore.com": "WebstaurantStore",
  "target.com": "Target",
  "bestbuy.com": "Best Buy",
  "ebay.com": "eBay",
  "uline.com": "Uline",
  "staples.com": "Staples",
  "costco.com": "Costco",
  "homedepot.com": "The Home Depot",
  "backmarket.com": "Back Market",
  "newegg.com": "Newegg",
};

function merchantFromDomain(domain: string | undefined, brand: string | undefined): string {
  const d = (domain ?? "").toLowerCase().replace(/^www\./, "");
  if (d && MERCHANT_NAMES[d]) return MERCHANT_NAMES[d];
  if (d) return d;
  return brand || "Unknown merchant";
}

async function liveSearch(query: string, quantity: number, limit: number, maxTotalCents?: number): Promise<MarketResult[]> {
  const body: Record<string, unknown> = { query, limit: Math.min(30, limit * 2) };
  // Price filter is per listing (in dollars). Only safe when buying a single unit; for bulk
  // the per-listing price of a pack can legitimately exceed total/quantity.
  if (quantity === 1 && maxTotalCents && maxTotalCents > 0) {
    body.filters = { price: { max_price: maxTotalCents / 100 } };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CHANNEL3_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.CHANNEL3_API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[channel3] HTTP ${res.status}: ${text.slice(0, 300)}`);
    return [];
  }
  const data = (await res.json()) as { products?: C3Product[] };
  const out: MarketResult[] = [];
  for (const p of data.products ?? []) {
    const offers = (p.offers ?? []).filter((o) => typeof o.price?.price === "number" && o.url);
    if (!offers.length || !p.title) continue;
    // Prefer an in-stock USD offer with the lowest price.
    offers.sort((a, b) => {
      const score = (o: C3Offer) =>
        (o.availability && o.availability !== "InStock" ? 1e9 : 0) +
        (o.price?.currency && o.price.currency !== "USD" ? 1e8 : 0) +
        (o.price?.price ?? 0);
      return score(a) - score(b);
    });
    const offer = offers[0];
    const listedPriceCents = Math.round((offer.price!.price as number) * 100);
    if (listedPriceCents <= 0) continue;
    const n = normalise(listedPriceCents, p.title, quantity);
    const image = p.images?.find((i) => i.is_main_image)?.url ?? p.images?.[0]?.url ?? null;
    out.push({
      title: p.title,
      merchant: merchantFromDomain(offer.domain, p.brands?.[0]?.name),
      priceCents: n.priceCents,
      estTotalCents: n.estTotalCents,
      url: offer.url!,
      imageUrl: image,
      raw: {
        source: "channel3",
        productId: p.id,
        listedPriceCents,
        currency: offer.price?.currency ?? "USD",
        packSize: n.packSize,
        packsNeeded: n.packs,
        availability: offer.availability ?? null,
        overBudget: maxTotalCents ? n.estTotalCents > maxTotalCents : undefined,
        offerCount: offers.length,
      },
    });
  }
  out.sort((a, b) => a.estTotalCents - b.estTotalCents);
  return out.slice(0, limit);
}
