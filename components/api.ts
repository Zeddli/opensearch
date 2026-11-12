"use client";
// Typed client for the OpenQuote JSON API (CONTRACTS §4–§5) + React Query hooks.
// Every hook tolerates missing routes (404) / server errors: they surface as `error`
// and the UI renders an empty state instead of crashing.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card, Message, ReceiptCard, Recommendation, RequestSpec, ProductDraft } from "@/src/agents/protocol";

export type { Card, Message, ReceiptCard, Recommendation, RequestSpec, ProductDraft };

export const POLL_MS = 1500;

// ---------- fetch layer ----------

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal,
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "Network error — is the server running?");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; issues?: Array<{ message?: string }> };
    const msg =
      d.issues?.[0]?.message ??
      d.error ??
      (res.status === 404 ? "Not available yet" : res.status === 401 ? "Please sign in again" : `Request failed (${res.status})`);
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const noRetry404 = (count: number, e: unknown) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && count < 2;

// ---------- shapes ----------

export type Role = "buyer" | "seller";
export type PublicUser = { id: string; email: string; name: string; role: Role };
export type Availability = "configured" | "missing";
/** `/api/status` (CONTRACTS-v2): platform integrations + whether the *current user* has an AI key. Payments = PayPal. */
export type IntegrationStatus = { paypal: Availability; channel3: Availability; ai: Availability };

export const AI_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced — default for buyers" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest, cheapest — default for sellers" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable, slower" },
] as const;

export type AiProvider = "anthropic" | "openai-compatible";
export type AiSettings = { configured: boolean; provider: AiProvider; baseUrl: string | null; last4: string | null; model: string | null };

/** Quick presets for the OpenAI-compatible base URL. Model hints are placeholders, not an availability claim. */
/** OpenAI-compatible endpoint presets; the first (OpenRouter) is the default in Settings. */
export const OPENAI_COMPATIBLE_PRESETS = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelHint: "e.g. provider/model-name:free", keyHint: "sk-or-…" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", modelHint: "e.g. gpt-4o-mini", keyHint: "sk-…" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", modelHint: "e.g. llama-3.3-70b-versatile", keyHint: "gsk_…" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", modelHint: "e.g. llama3.1", keyHint: "Optional for local Ollama" },
] as const;

export type SessionSummary = {
  id: string;
  title: string;
  kind: Role;
  status: string;
  badge?: string;
  updatedAt: string;
};

export type RequestStatus = "draft" | "open" | "analyzing" | "recommended" | "approved" | "paid" | "closed";

export type RequestRow = {
  id: string;
  sessionId: string;
  buyerId: string;
  title: string;
  spec: RequestSpec;
  budgetMaxCents: number;
  deadline: string;
  location: string;
  status: RequestStatus;
  windowEndsAt: string | null;
  recommendation: Recommendation | null;
  createdAt: string;
};

export type SessionDetail = { session: SessionSummary; messages: Message[]; request: RequestRow | null };

export type ForumRequest = {
  id: string;
  title: string;
  status: RequestStatus;
  spec: RequestSpec;
  buyerName: string;
  offerCount: number;
  createdAt: string;
  match?: { productId: string; confidence: number };
};

export type PostType = "request" | "offer" | "question" | "answer" | "counter" | "revision" | "system";
export type ForumPost = {
  id: string;
  requestId: string;
  authorKind: "buyer_agent" | "seller_agent" | "system";
  authorId: string | null;
  type: PostType;
  body: string;
  offerId: string | null;
  replyTo: string | null;
  createdAt: string;
  authorName?: string;
};

export type OfferStatus = "active" | "countered" | "revised" | "won" | "lost" | "withdrawn";
export type Offer = {
  id: string;
  requestId: string;
  sellerId: string;
  productId: string;
  unitPriceCents: number;
  quantity: number;
  shippingCents: number;
  totalCents: number;
  etaDays: number;
  warranty: string | null;
  returnPolicy: string | null;
  terms: string | null;
  pitch: string;
  status: OfferStatus;
  version: number;
  aiScore: number | null;
  specMatch: number | null;
  flags: string[];
  rationale: string | null;
  createdAt: string;
  updatedAt: string;
  sellerName: string;
  sellerRating: number;
  productTitle: string;
  meetsDeadline: boolean;
};

export type MarketListing = {
  id: string;
  requestId: string;
  source: string;
  title: string;
  merchant: string;
  priceCents: number;
  estTotalCents: number;
  url: string;
  imageUrl: string | null;
  createdAt?: string;
};

export type OffersResponse = { offers: Offer[]; listings: MarketListing[]; recommendation: Recommendation | null };

export type ApproveResult =
  | { result: "paid"; orderId: string; receipt: ReceiptCard }
  | { result: "needs_popup"; paypalOrderId?: string }
  | { result: "denied"; reason: string };

export type PaidResult = { orderId: string; receipt: ReceiptCard };

export type BuyerSettings = {
  autoPayLimitCents: number;
  monthlyCapCents: number;
  spentThisMonthCents: number;
  paypalLinked: boolean;
  paypalVaultId: string | null;
  /** The agent can pay under the limit (PayPal saved). */
  autoPayEnabled: boolean;
  /** Whether PayPal is configured on this server (null if the route didn't say). */
  paypal: Availability | null;
};

export type SellerSettings = {
  displayName: string;
  tagline: string;
  paypalMerchantId: string | null;
  onboardingStatus: "none" | "pending" | "complete";
  shopifyDomain: string | null;
  shopifyConnected: boolean;
  productCounts: { total: number; active: number; chat: number; shopify: number } | null;
  autoDeal: boolean;
  platformFeeEnabled: boolean;
  /** Buyers can pay this seller (PayPal merchant id set and PayPal configured). */
  payoutReady: boolean;
  /** Whether PayPal is configured on this server (null if the route didn't say). */
  paypal: Availability | null;
};

export type Product = {
  id: string;
  sellerId: string;
  source: "chat" | "shopify";
  title: string;
  description: string;
  category: string;
  unitPriceCents: number;
  stock: number;
  moq: number;
  leadTimeDays: number;
  attributes: Record<string, unknown>;
  floorPriceCents: number;
  maxDiscountPct: number;
  maxQtyPerOrder: number | null;
  imageUrl: string | null;
  active: boolean;
  createdAt: string;
};

export type Deal = {
  offerId: string;
  requestId: string;
  requestTitle: string;
  buyerName: string;
  status: string;
  unitPriceCents: number;
  quantity: number;
  totalCents: number;
  budgetMaxCents: number;
  competingOffers: number;
  updatedAt: string;
};

// ---------- normalizers (tolerate small shape differences between teams) ----------

type AnyRec = Record<string, unknown>;
const pick = (d: unknown, ...keys: string[]): AnyRec => {
  const o = (d ?? {}) as AnyRec;
  for (const k of keys) if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) return o[k] as AnyRec;
  return o;
};
const list = <T,>(d: unknown, key: string): T[] => {
  if (Array.isArray(d)) return d as T[];
  const v = (d as AnyRec | null)?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
};

function normBuyerSettings(d: unknown): BuyerSettings {
  const s = pick(d, "settings", "profile");
  return {
    autoPayLimitCents: Number(s.autoPayLimitCents ?? 20000),
    monthlyCapCents: Number(s.monthlyCapCents ?? 100000),
    spentThisMonthCents: Number(s.spentThisMonthCents ?? 0),
    paypalVaultId: (s.paypalVaultId as string) ?? null,
    paypalLinked: Boolean(s.paypalLinked ?? s.paypalVaultId),
    autoPayEnabled: Boolean(s.autoPayEnabled ?? s.paypalLinked),
    paypal: s.paypal === undefined ? null : avail(s.paypal),
  };
}

function normSellerSettings(d: unknown): SellerSettings {
  const s = pick(d, "settings", "profile");
  return {
    displayName: String(s.displayName ?? ""),
    tagline: String(s.tagline ?? ""),
    paypalMerchantId: (s.paypalMerchantId as string) ?? null,
    onboardingStatus: (s.onboardingStatus as SellerSettings["onboardingStatus"]) ?? "none",
    shopifyDomain: ((s.shopify as AnyRec | undefined)?.domain as string) ?? (s.shopifyDomain as string) ?? null,
    shopifyConnected: Boolean((s.shopify as AnyRec | undefined)?.connected ?? s.shopifyConnected ?? s.shopifyDomain),
    productCounts: (s.productCounts as SellerSettings["productCounts"]) ?? null,
    autoDeal: s.autoDeal === undefined ? true : Boolean(s.autoDeal),
    platformFeeEnabled: Boolean(s.platformFeeEnabled),
    payoutReady: Boolean(s.payoutReady ?? (s.onboardingStatus === "complete" || s.paypalMerchantId)),
    paypal: s.paypal === undefined ? null : avail(s.paypal),
  };
}

const avail = (v: unknown): Availability => (v === "configured" || v === "live" ? "configured" : "missing");
function normStatus(d: unknown): IntegrationStatus {
  const o = (d ?? {}) as AnyRec;
  return { paypal: avail(o.paypal), channel3: avail(o.channel3), ai: avail(o.ai) };
}

function normAiSettings(d: unknown): AiSettings {
  const s = pick(d, "settings");
  return {
    configured: Boolean(s.configured),
    provider: s.provider === "openai-compatible" ? "openai-compatible" : "anthropic",
    baseUrl: typeof s.baseUrl === "string" && s.baseUrl ? s.baseUrl : null,
    last4: typeof s.last4 === "string" && s.last4 ? s.last4 : null,
    model: typeof s.model === "string" && s.model ? s.model : null,
  };
}

// ---------- query keys ----------

export const qk = {
  me: ["me"] as const,
  status: ["status"] as const,
  aiSettings: ["aiSettings"] as const,
  sessions: ["sessions"] as const,
  session: (id: string) => ["session", id] as const,
  forum: ["forum"] as const,
  thread: (requestId: string) => ["thread", requestId] as const,
  offers: (requestId: string) => ["offers", requestId] as const,
  buyerSettings: ["buyerSettings"] as const,
  sellerSettings: ["sellerSettings"] as const,
  products: ["products"] as const,
  deals: ["deals"] as const,
};

// ---------- hooks ----------

export function useStatus() {
  return useQuery({
    queryKey: qk.status,
    queryFn: async () => normStatus(await api<unknown>("/api/status")),
    staleTime: 30_000,
    retry: noRetry404,
  });
}

export function useAiSettings() {
  return useQuery({
    queryKey: qk.aiSettings,
    queryFn: async () => normAiSettings(await api<unknown>("/api/settings/ai")),
    retry: noRetry404,
  });
}
export const putAiSettings = (body: { provider: AiProvider; apiKey?: string; model?: string; baseUrl?: string }) =>
  api<unknown>("/api/settings/ai", { method: "PUT", body }).then(normAiSettings);
export const deleteAiSettings = () => api<unknown>("/api/settings/ai", { method: "DELETE" });

/** True for the 503 every PayPal route returns when the platform has no PayPal credentials. */
export const isPaypalUnconfigured = (e: unknown) => e instanceof ApiError && e.status === 503;
export const PAYPAL_UNCONFIGURED_MSG = "PayPal is not configured on this server, so payments are unavailable right now.";

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: async () => list<SessionSummary>(await api<unknown>("/api/sessions"), "sessions"),
    refetchInterval: 2500,
    retry: noRetry404,
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: qk.session(id ?? ""),
    queryFn: () => api<SessionDetail>(`/api/sessions/${id}`),
    enabled: Boolean(id),
    refetchInterval: 5000,
    retry: noRetry404,
  });
}

export function fetchMessagesAfter(sessionId: string, after: string | null, signal?: AbortSignal) {
  const q = after ? `?after=${encodeURIComponent(after)}` : "";
  return api<{ messages: Message[] }>(`/api/sessions/${sessionId}/messages${q}`, { signal }).then((d) =>
    list<Message>(d, "messages"),
  );
}

export function sendChat(sessionId: string, text: string) {
  return api<{ messages: Message[] }>("/api/chat", { body: { sessionId, text } }).then((d) => list<Message>(d, "messages"));
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const d = await api<{ session: SessionSummary }>("/api/sessions", { method: "POST", body: {} });
      return d.session;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useForum(enabled = true) {
  return useQuery({
    queryKey: qk.forum,
    queryFn: async () => list<ForumRequest>(await api<unknown>("/api/forum"), "requests"),
    refetchInterval: POLL_MS * 2,
    enabled,
    retry: noRetry404,
  });
}

export function useThread(requestId: string | null | undefined) {
  return useQuery({
    queryKey: qk.thread(requestId ?? ""),
    queryFn: async () => {
      const d = await api<{ request: RequestRow; posts: ForumPost[] }>(`/api/forum/${requestId}`);
      return { request: d.request ?? null, posts: list<ForumPost>(d, "posts") };
    },
    enabled: Boolean(requestId),
    refetchInterval: POLL_MS,
    retry: noRetry404,
  });
}

export function useOffers(requestId: string | null | undefined, opts?: { poll?: boolean }) {
  return useQuery({
    queryKey: qk.offers(requestId ?? ""),
    queryFn: async (): Promise<OffersResponse> => {
      const d = await api<Partial<OffersResponse>>(`/api/requests/${requestId}/offers`);
      return {
        offers: list<Offer>(d, "offers").map((o) => ({ ...o, flags: Array.isArray(o.flags) ? o.flags : [] })),
        listings: list<MarketListing>(d, "listings"),
        recommendation: d?.recommendation ?? null,
      };
    },
    enabled: Boolean(requestId),
    refetchInterval: opts?.poll === false ? false : POLL_MS,
    retry: noRetry404,
  });
}

export function patchRequest(id: string, spec: RequestSpec) {
  return api<unknown>(`/api/requests/${id}`, { method: "PATCH", body: { spec } });
}
export function postRequest(id: string) {
  return api<unknown>(`/api/requests/${id}/post`, { method: "POST", body: {} });
}

// Payments
export const approveOffer = (offerId: string) =>
  api<ApproveResult>(`/api/offers/${offerId}/approve`, { method: "POST", body: {} });
export const createPaypalOrder = (offerId: string) =>
  api<{ id: string }>("/api/paypal/orders", { body: { offerId } }).then((d) => d.id);
export const capturePaypalOrder = (paypalOrderId: string, offerId: string) =>
  api<PaidResult>(`/api/paypal/orders/${paypalOrderId}/capture`, { body: { offerId } });

export function useBuyerSettings(enabled = true) {
  return useQuery({
    queryKey: qk.buyerSettings,
    queryFn: async () => normBuyerSettings(await api<unknown>("/api/buyer/settings")),
    enabled,
    retry: noRetry404,
  });
}
export const patchBuyerSettings = (body: { autoPayLimitCents: number; monthlyCapCents: number }) =>
  api<unknown>("/api/buyer/settings", { method: "PATCH", body });
export const vaultSetupToken = () => api<{ id: string; approveUrl?: string }>("/api/paypal/vault/setup-token", { body: {} });
export const vaultConfirm = (setupTokenId: string) =>
  api<{ vaultId: string }>("/api/paypal/vault/confirm", { body: { setupTokenId } });

// Seller
export function useSellerSettings(enabled = true) {
  return useQuery({
    queryKey: qk.sellerSettings,
    queryFn: async () => normSellerSettings(await api<unknown>("/api/seller/settings")),
    enabled,
    retry: noRetry404,
  });
}
export const patchSellerSettings = (body: Partial<{ paypalMerchantId: string; autoDeal: boolean; displayName: string; tagline: string }>) =>
  api<unknown>("/api/seller/settings", { method: "PATCH", body });
export const paypalOnboard = () => api<{ actionUrl: string }>("/api/paypal/onboard", { body: {} });
export const shopifyConnect = (domain: string, token: string) =>
  api<{ connected: boolean; domain: string; shopName?: string; mode?: string }>("/api/shopify/connect", { body: { domain, token } });
export const shopifyDisconnect = () => api<unknown>("/api/shopify/connect", { method: "DELETE" });
export const shopifyImport = () => api<{ imported: number }>("/api/shopify/import", { body: {} });

export function useProducts(enabled = true) {
  return useQuery({
    queryKey: qk.products,
    queryFn: async () => list<Product>(await api<unknown>("/api/seller/products"), "products"),
    enabled,
    refetchInterval: 5000,
    retry: noRetry404,
  });
}
export const createProduct = (draft: ProductDraft, messageId?: string) =>
  api<{ product?: Product; id?: string }>("/api/seller/products", { body: { draft, messageId } });
export const patchProduct = (id: string, body: Partial<Product>) =>
  api<unknown>(`/api/seller/products/${id}`, { method: "PATCH", body });

export function useDeals(enabled = true) {
  return useQuery({
    queryKey: qk.deals,
    queryFn: async () => list<Deal>(await api<unknown>("/api/seller/deals"), "deals"),
    enabled,
    refetchInterval: POLL_MS,
    retry: noRetry404,
  });
}

export const logout = () => api<unknown>("/api/auth/logout", { method: "POST", body: {} });
