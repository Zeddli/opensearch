// Agent protocol: Zod schemas + inferred types (CONTRACTS §3, §4).
// AGENTS may append new types at the END of this file.
import { z } from "zod";

const cents = z.number().int().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// ---- §3 Agent protocol ----

export const RequestSpecSchema = z.object({
  item: z.string().min(1),
  category: z.string().optional(),
  quantity: z.number().int().positive(),
  unit: z.string().optional(),
  budgetMaxCents: cents,
  deadline: isoDate,
  location: z.string().min(1),
  mustHave: z.array(z.string()).default([]),
  niceToHave: z.array(z.string()).default([]),
});
export type RequestSpec = z.infer<typeof RequestSpecSchema>;

export const OfferInputSchema = z.object({
  requestId: z.string(),
  productId: z.string(),
  unitPriceCents: cents,
  quantity: z.number().int().positive(),
  shippingCents: cents,
  etaDays: z.number().int().nonnegative(),
  warranty: z.string().optional(),
  returnPolicy: z.string().optional(),
  terms: z.string().optional(),
  pitch: z.string(),
});
export type OfferInput = z.infer<typeof OfferInputSchema>;

export const CounterSchema = z.object({
  offerId: z.string(),
  targetUnitPriceCents: cents.optional(),
  targetEtaDays: z.number().int().nonnegative().optional(),
  message: z.string(),
});
export type Counter = z.infer<typeof CounterSchema>;

export const RecommendationSchema = z.object({
  topOfferId: z.string(),
  alternativeOfferIds: z.array(z.string()),
  summary: z.string(),
  savingsVsMarketCents: z.number().int().nullable(),
  reasons: z.record(z.string(), z.string()), // offerId -> reason
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

// ---- §4 Chat cards ----

export const ProductDraftSchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.string(),
  unitPriceCents: cents,
  stock: z.number().int().nonnegative(),
  moq: z.number().int().positive(),
  leadTimeDays: z.number().int().nonnegative(),
  floorPriceCents: cents,
  maxDiscountPct: z.number().int().min(0).max(100),
  attributes: z.record(z.string(), z.unknown()),
});
export type ProductDraft = z.infer<typeof ProductDraftSchema>;

export const RequestSummaryCardSchema = z.object({
  type: z.literal("request_summary"),
  requestId: z.string(),
  spec: RequestSpecSchema,
  posted: z.boolean(),
});
export const ProductConfirmCardSchema = z.object({
  type: z.literal("product_confirm"),
  draft: ProductDraftSchema,
  savedProductId: z.string().optional(),
});
export const RecommendationCardSchema = z.object({
  type: z.literal("recommendation"),
  requestId: z.string(),
  recommendation: RecommendationSchema,
});
export const ReceiptCardSchema = z.object({
  type: z.literal("receipt"),
  orderId: z.string(),
  amountCents: cents,
  platformFeeCents: cents,
  sellerName: z.string(),
  paypalOrderId: z.string().nullable(),
  /** vault = agent auto-pay via saved PayPal, popup = PayPal checkout. */
  mode: z.enum(["vault", "popup"]),
});
export const StatusCardSchema = z.object({
  type: z.literal("status"),
  text: z.string(),
  tone: z.enum(["info", "success", "warning"]).optional(),
  /** Optional call to action, e.g. {label: "Open settings", href: "/settings"}. */
  action: z.object({ label: z.string(), href: z.string() }).optional(),
});

export const CardSchema = z.discriminatedUnion("type", [
  RequestSummaryCardSchema,
  ProductConfirmCardSchema,
  RecommendationCardSchema,
  ReceiptCardSchema,
  StatusCardSchema,
]);
export type RequestSummaryCard = z.infer<typeof RequestSummaryCardSchema>;
export type ProductConfirmCard = z.infer<typeof ProductConfirmCardSchema>;
export type RecommendationCard = z.infer<typeof RecommendationCardSchema>;
export type ReceiptCard = z.infer<typeof ReceiptCardSchema>;
export type StatusCard = z.infer<typeof StatusCardSchema>;
export type Card = z.infer<typeof CardSchema>;

/** Chat message as returned by the API (JSON-serialized; createdAt is an ISO string). */
export type MessageRole = "user" | "assistant" | "system";
export type Message = {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  card: Card | null;
  createdAt: string;
};
