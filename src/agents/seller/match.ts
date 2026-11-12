// Request → product pre-filter (deterministic, no LLM call). `scoreMatch` is a keyword/category
// relevance 0..1; it sorts the forum list in the UI and picks the catalog candidates a seller agent
// shows its LLM in ONE offer decision (which product, if any, and at what price). Products sharing no
// keyword or category with the request never cost the seller an LLM call.
import type { Product } from "@/src/db";
import type { RequestSpec } from "@/src/agents/protocol";
import { tokens } from "@/src/agents/util";

/** Forum UI: show "matches your product" at or above this relevance. */
export const MATCH_THRESHOLD = 0.4;
/** Most catalog products a seller agent considers for one request. */
export const MAX_CANDIDATES = 5;

function productText(p: Product): string {
  const attrs = Object.entries(p.attributes ?? {})
    .map(([k, v]) => `${k} ${typeof v === "boolean" ? (v ? k : "") : Array.isArray(v) ? v.join(" ") : String(v)}`)
    .join(" ");
  return `${p.title} ${p.description} ${p.category} ${attrs}`;
}

/** Deterministic keyword + category relevance 0..1. */
export function scoreMatch(spec: RequestSpec, p: Product): number {
  const req = new Set(tokens(`${spec.item} ${spec.mustHave.join(" ")} ${spec.category ?? ""}`));
  if (!req.size) return 0;
  const prod = new Set(tokens(productText(p)));
  let hit = 0;
  for (const t of req) if (prod.has(t) || (t.length > 4 && [...prod].some((x) => x.length > 4 && (x.startsWith(t) || t.startsWith(x))))) hit++;
  const overlap = hit / req.size;
  const cat = spec.category && spec.category.toLowerCase() === p.category.toLowerCase() ? 0.35 : 0;
  return Math.min(1, Math.round((overlap * 0.75 + cat) * 100) / 100);
}

/** Catalog products that share at least a keyword or the category with the request, best first. */
export function candidateProducts(spec: RequestSpec, catalog: Product[], max = MAX_CANDIDATES): Array<{ product: Product; relevance: number }> {
  return catalog
    .map((product) => ({ product, relevance: scoreMatch(spec, product) }))
    .filter((c) => c.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, max);
}
