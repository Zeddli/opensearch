// Drizzle schema (CONTRACTS §2). Money = integer cents. IDs = crypto.randomUUID() strings.
// After editing: `npm run db:generate` to create a new migration in ./drizzle.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Card, Recommendation, RequestSpec } from "@/src/agents/protocol";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["buyer", "seller"] }).notNull(),
  createdAt: createdAt(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(), // session token
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

export const buyerProfiles = pgTable("buyer_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  autoPayLimitCents: integer("auto_pay_limit_cents").notNull().default(20000),
  monthlyCapCents: integer("monthly_cap_cents").notNull().default(100000),
  spentThisMonthCents: integer("spent_this_month_cents").notNull().default(0),
  paypalVaultId: text("paypal_vault_id"),
  paypalCustomerId: text("paypal_customer_id"),
  createdAt: createdAt(),
});

export const sellerProfiles = pgTable("seller_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  tagline: text("tagline").notNull().default(""),
  rating: real("rating").notNull().default(4.5),
  paypalMerchantId: text("paypal_merchant_id"),
  onboardingStatus: text("onboarding_status", { enum: ["none", "pending", "complete"] })
    .notNull()
    .default("none"),
  platformFeeEnabled: boolean("platform_fee_enabled").notNull().default(false),
  shopifyDomain: text("shopify_domain"),
  shopifyTokenEnc: text("shopify_token_enc"),
  autoDeal: boolean("auto_deal").notNull().default(true),
  createdAt: createdAt(),
});

export const products = pgTable(
  "products",
  {
    id: id(),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["chat", "shopify"] }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("general"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    stock: integer("stock").notNull().default(0),
    moq: integer("moq").notNull().default(1),
    leadTimeDays: integer("lead_time_days").notNull().default(3),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    floorPriceCents: integer("floor_price_cents").notNull(),
    maxDiscountPct: integer("max_discount_pct").notNull().default(15),
    maxQtyPerOrder: integer("max_qty_per_order"),
    imageUrl: text("image_url"),
    shopifyProductId: text("shopify_product_id"),
    shopifyVariantId: text("shopify_variant_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("products_seller_idx").on(t.sellerId)],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New session"),
    kind: text("kind", { enum: ["buyer", "seller"] }).notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_sessions_user_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull().default(""),
    card: jsonb("card").$type<Card>(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_session_created_idx").on(t.sessionId, t.createdAt)],
);

export const requests = pgTable(
  "requests",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    spec: jsonb("spec").$type<RequestSpec>().notNull(),
    budgetMaxCents: integer("budget_max_cents").notNull(),
    deadline: date("deadline", { mode: "string" }).notNull(), // 'YYYY-MM-DD'
    location: text("location").notNull(),
    status: text("status", {
      enum: ["draft", "open", "analyzing", "recommended", "approved", "paid", "closed"],
    })
      .notNull()
      .default("draft"),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }),
    recommendation: jsonb("recommendation").$type<Recommendation>(),
    createdAt: createdAt(),
  },
  (t) => [index("requests_session_idx").on(t.sessionId), index("requests_status_idx").on(t.status)],
);

export const forumPosts = pgTable(
  "forum_posts",
  {
    id: id(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: ["buyer_agent", "seller_agent", "system"] }).notNull(),
    authorId: text("author_id"),
    type: text("type", {
      enum: ["request", "offer", "question", "answer", "counter", "revision", "system"],
    }).notNull(),
    body: text("body").notNull(),
    offerId: text("offer_id"),
    replyTo: text("reply_to"),
    createdAt: createdAt(),
  },
  (t) => [index("forum_posts_request_idx").on(t.requestId, t.createdAt)],
);

export const offers = pgTable(
  "offers",
  {
    id: id(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    shippingCents: integer("shipping_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    etaDays: integer("eta_days").notNull(),
    warranty: text("warranty"),
    returnPolicy: text("return_policy"),
    terms: text("terms"),
    pitch: text("pitch").notNull().default(""),
    status: text("status", {
      enum: ["active", "countered", "revised", "won", "lost", "withdrawn"],
    })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    aiScore: real("ai_score"),
    specMatch: real("spec_match"),
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rationale: text("rationale"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("offers_request_idx").on(t.requestId), index("offers_seller_idx").on(t.sellerId)],
);

export const marketListings = pgTable(
  "market_listings",
  {
    id: id(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("channel3"),
    title: text("title").notNull(),
    merchant: text("merchant").notNull(),
    priceCents: integer("price_cents").notNull(),
    estTotalCents: integer("est_total_cents").notNull(),
    url: text("url").notNull(),
    imageUrl: text("image_url"),
    raw: jsonb("raw").$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [index("market_listings_request_idx").on(t.requestId)],
);

export const orders = pgTable("orders", {
  id: id(),
  offerId: text("offer_id")
    .notNull()
    .unique()
    .references(() => offers.id, { onDelete: "cascade" }),
  requestId: text("request_id")
    .notNull()
    .references(() => requests.id, { onDelete: "cascade" }),
  buyerId: text("buyer_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sellerId: text("seller_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  platformFeeCents: integer("platform_fee_cents").notNull().default(0),
  paypalOrderId: text("paypal_order_id"),
  paypalCaptureId: text("paypal_capture_id"),
  mode: text("mode", { enum: ["vault", "popup"] }).notNull(),
  status: text("status", { enum: ["created", "paid", "failed"] })
    .notNull()
    .default("created"),
  shopifyOrderId: text("shopify_order_id"),
  createdAt: createdAt(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  offerId: text("offer_id")
    .notNull()
    .references(() => offers.id, { onDelete: "cascade" }),
  buyerId: text("buyer_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  createdAt: createdAt(),
});

export const agentEvents = pgTable(
  "agent_events",
  {
    id: id(),
    requestId: text("request_id").references(() => requests.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    tool: text("tool").notNull(),
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    decision: text("decision"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_events_request_idx").on(t.requestId)],
);

/** Per-user AI provider key (encrypted with APP_ENCRYPTION_KEY, see src/lib/secrets.ts). */
export const userAiSettings = pgTable("user_ai_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 'anthropic' | 'openai-compatible' (see AiProvider in src/agents/llm.ts). */
  provider: text("provider").notNull().default("anthropic"),
  /** Encrypted key. Empty string (encrypted) = keyless local endpoint (dev only, e.g. Ollama). */
  apiKeyEnc: text("api_key_enc").notNull(),
  keyLast4: text("key_last4"),
  /** Required for 'openai-compatible'; null = default Claude model for 'anthropic'. */
  model: text("model"),
  /** OpenAI-compatible endpoint, e.g. https://api.openai.com/v1. Null for 'anthropic'. */
  baseUrl: text("base_url"),
  updatedAt: updatedAt(),
});

// ---- Inferred row types ----
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type BuyerProfile = typeof buyerProfiles.$inferSelect;
export type NewBuyerProfile = typeof buyerProfiles.$inferInsert;
export type SellerProfile = typeof sellerProfiles.$inferSelect;
export type NewSellerProfile = typeof sellerProfiles.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type RequestRow = typeof requests.$inferSelect;
export type NewRequestRow = typeof requests.$inferInsert;
export type ForumPost = typeof forumPosts.$inferSelect;
export type NewForumPost = typeof forumPosts.$inferInsert;
export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
export type MarketListing = typeof marketListings.$inferSelect;
export type NewMarketListing = typeof marketListings.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type NewAgentEvent = typeof agentEvents.$inferInsert;
export type UserAiSettings = typeof userAiSettings.$inferSelect;
