# Build Contracts (source of truth for all engineers)

This file overrides `03-architecture.md` where they differ. Read it fully before writing code.

## 0. Ground rules
- Stack: **Next.js 15 (App Router) + TypeScript + Tailwind v4**, Node 25, npm. Windows dev machine (Git Bash available).
- **Do not run `npm install` / add dependencies** unless you are the foundation engineer. If you truly need a package, report it in your final message instead.
- **Only edit files you own** (§9). If you need a change in someone else's file, put a note in your final report.
- Every integration has **live mode** (env key present) and **mock mode** (key missing). Mock mode must make the full demo work with no keys. `src/lib/env.ts` exposes `live.anthropic`, `live.paypal`, `live.channel3`, `live.shopify` booleans.
- Money is **integer cents** everywhere (`*_cents`). Currency USD.
- IDs: `crypto.randomUUID()` strings.
- Live updates: client **polling** every 1500ms. No websockets/SSE.
- Chat is **non-streaming JSON** (simpler, works in mock mode).
- Background jobs: **in-process runner** (`src/jobs/runner.ts`), not pg-boss.
- Verify your work with `npx tsc --noEmit` (fix only errors in your files) and by exercising your routes with `curl` against `npm run dev` (port 3000) when possible. Another engineer may already be running a dev server on 3000 — if so, use it rather than starting another; if you must start one use port 3001+.

## 1. Environment (`.env.example`)
```
DATABASE_URL=                 # empty → embedded PGlite at ./.data/pglite
SESSION_SECRET=dev-secret-change-me
ANTHROPIC_API_KEY=            # empty → mock agents (rule-based)
ANTHROPIC_API_BASE_URL=https://api.anthropic.com/v1   # pass explicitly as baseURL to createAnthropic; do NOT rely on ANTHROPIC_BASE_URL
BUYER_MODEL=claude-sonnet-5-5
SELLER_MODEL=claude-haiku-5-5
PAYPAL_CLIENT_ID=             # empty → simulated PayPal
PAYPAL_CLIENT_SECRET=
PAYPAL_PARTNER_MERCHANT_ID=
PAYPAL_BN_CODE=
NEXT_PUBLIC_PAYPAL_CLIENT_ID=
PLATFORM_FEE_BPS=300          # 3%
CHANNEL3_API_KEY=             # empty → mock market listings
SHOPIFY_TOKEN_ENC_KEY=dev-key-change-me
NEXT_PUBLIC_AG_GRID_LICENSE_KEY=
OFFER_WINDOW_SECONDS=45
APP_URL=http://localhost:3000
```

## 2. Database (`src/db/schema.ts`, Drizzle pg-core)
Client `src/db/index.ts` exports **async** `getDb(): Promise<Db>` (lazy; PGlite if no `DATABASE_URL`, else postgres-js) and runs migrations from `./drizzle` once on first use — always `const db = await getDb()`. It also re-exports every table + type from `schema.ts` (`import { getDb, offers, type Offer } from "@/src/db"`) and `closeDb()` for scripts. Schema change → edit `schema.ts` (F0-owned; ask) → `npm run db:generate`. **PGlite is single-process**: don't run `npm run seed`/scripts while `npm run dev` holds `./.data/pglite` (stop the server first, or expose the seed as a function a route can call). Scripts run as CJS via tsx: wrap code in `async function main()` (no top-level await). Columns are camelCase in TS (`unitPriceCents`), snake_case in SQL. Text "enums" are typed unions; nullable = only where marked null below; `requests.deadline` is a `'YYYY-MM-DD'` string. Tables (snake_case columns, `created_at timestamptz default now()` on all):

- `users`: id, email (unique), name, password_hash, role (`'buyer'|'seller'`)
- `auth_sessions`: id (token), user_id, expires_at
- `buyer_profiles`: user_id (pk), auto_pay_limit_cents int default 20000, monthly_cap_cents int default 100000, spent_this_month_cents int default 0, paypal_vault_id text null, paypal_customer_id text null
- `seller_profiles`: user_id (pk), display_name, tagline text, persona text null (seeded agents only), is_seeded bool default false, rating real default 4.5, paypal_merchant_id text null, onboarding_status (`'none'|'pending'|'complete'`) default 'none', platform_fee_enabled bool default false, shopify_domain text null, shopify_token_enc text null, auto_deal bool default true
- `products`: id, seller_id, source (`'chat'|'shopify'|'seed'`), title, description, category, unit_price_cents, stock int, moq int default 1, lead_time_days int, attributes jsonb default {}, floor_price_cents int, max_discount_pct int default 15, max_qty_per_order int null, image_url text null, shopify_product_id text null, shopify_variant_id text null, active bool default true
- `chat_sessions`: id, user_id, title, kind (`'buyer'|'seller'`), status text default 'active', updated_at
- `messages`: id, session_id, role (`'user'|'assistant'|'system'`), content text, card jsonb null (see §4)
- `requests`: id, session_id, buyer_id, title, spec jsonb (RequestSpec), budget_max_cents, deadline date, location, status (`'draft'|'open'|'analyzing'|'recommended'|'approved'|'paid'|'closed'`), window_ends_at timestamptz null, recommendation jsonb null (Recommendation)
- `forum_posts`: id, request_id, author_kind (`'buyer_agent'|'seller_agent'|'system'`), author_id text null (user id), type (`'request'|'offer'|'question'|'answer'|'counter'|'revision'|'system'`), body text, offer_id text null, reply_to text null
- `offers`: id, request_id, seller_id, product_id, unit_price_cents, quantity, shipping_cents, total_cents, eta_days, warranty text null, return_policy text null, terms text null, pitch text, status (`'active'|'countered'|'revised'|'won'|'lost'|'withdrawn'`), version int default 1, ai_score real null, spec_match real null, flags text[] default {}, rationale text null, updated_at
- `market_listings`: id, request_id, source text default 'channel3', title, merchant, price_cents, est_total_cents, url, image_url, raw jsonb
- `orders`: id, offer_id (unique), request_id, buyer_id, seller_id, amount_cents, platform_fee_cents, paypal_order_id text null, paypal_capture_id text null, mode (`'vault'|'popup'|'simulated'`), status (`'created'|'paid'|'failed'`), shopify_order_id text null
- `approvals`: id, offer_id, buyer_id, amount_cents, created_at
- `agent_events`: id, request_id null, actor text, tool text, input jsonb, output jsonb, decision text null

## 3. Agent protocol (`src/agents/protocol.ts`, Zod + inferred types)
```ts
RequestSpec = { item: string; category?: string; quantity: number; unit?: string;
  budgetMaxCents: number; deadline: string /*YYYY-MM-DD*/; location: string;
  mustHave: string[]; niceToHave: string[] }
OfferInput = { requestId; productId; unitPriceCents; quantity; shippingCents; etaDays;
  warranty?; returnPolicy?; terms?; pitch }
Counter = { offerId; targetUnitPriceCents?: number; targetEtaDays?: number; message: string }
Recommendation = { topOfferId: string; alternativeOfferIds: string[]; summary: string;
  savingsVsMarketCents: number | null; reasons: Record<string /*offerId*/, string> }
```

## 4. Chat messages & cards
`messages.card` is a discriminated union (`src/agents/protocol.ts` exports `Card`):
- `{ type: 'request_summary', requestId, spec: RequestSpec, posted: boolean }` — buttons: "Post to forum" (POST `/api/requests/:id/post`), edit fields inline (PATCH `/api/requests/:id`)
- `{ type: 'product_confirm', draft: {title, description, category, unitPriceCents, stock, moq, leadTimeDays, floorPriceCents, maxDiscountPct, attributes}, savedProductId?: string }` — button "Save product" (POST `/api/seller/products` with draft, then the card is updated with savedProductId)
- `{ type: 'recommendation', requestId, recommendation: Recommendation }` — the UI fetches offers to render; buttons "Approve & pay" per offer → POST `/api/offers/:id/approve`
- `{ type: 'receipt', orderId, amountCents, platformFeeCents, sellerName, paypalOrderId, mode }`
- `{ type: 'status', text: string, tone?: 'info'|'success'|'warning' }`

## 5. API routes (all JSON; auth via `aa_session` httpOnly cookie; helper `requireUser(role?)` in `src/lib/auth.ts` — reads the cookie via `next/headers`, no `req` arg)
Owner in brackets.

Auth [F0]: `POST /api/auth/signup {email,password,name,role}` · `POST /api/auth/login {email,password}` · `POST /api/auth/logout` · `GET /api/auth/me → {user|null}`
Status [F0]: `GET /api/status → {anthropic,paypal,channel3,shopify: 'live'|'mock'}`

Sessions & chat [AGENTS]:
- `GET /api/sessions → {sessions:[{id,title,kind,status,badge?:string,updatedAt}]}` (badge e.g. "3 offers", "collecting", "paid ✓")
- `POST /api/sessions → {session}` (kind = user role)
- `GET /api/sessions/:id → {session, messages, request|null}`
- `POST /api/chat {sessionId, text} → {messages: Message[]}` (returns only NEW messages: the user msg + agent replies)
- `GET /api/sessions/:id/messages?after=<iso> → {messages}` (polling for agent messages produced by background jobs)

Forum & requests [AGENTS]:
- `GET /api/forum → {requests:[{id,title,status,spec,buyerName,offerCount,createdAt, match?:{productId,confidence}}]}` (sellers get `match` for their catalog)
- `GET /api/forum/:requestId → {request, posts:[{...post, authorName}]}`
- `PATCH /api/requests/:id {spec}` · `POST /api/requests/:id/post`
- `GET /api/requests/:id/offers → {offers:[offer + sellerName, sellerRating, productTitle, meetsDeadline]}, listings, recommendation}`

Payments [PAYMENTS]:
- `POST /api/offers/:id/approve → {result: 'paid', orderId, receipt} | {result:'needs_popup', paypalOrderId?, simulated: boolean}`
- `POST /api/paypal/orders {offerId} → {id}` (popup createOrder) · `POST /api/paypal/orders/:id/capture {offerId} → {orderId, receipt}`
- `POST /api/paypal/simulate-pay {offerId} → {orderId, receipt}` (mock mode only)
- `GET /api/buyer/settings` · `PATCH /api/buyer/settings {autoPayLimitCents, monthlyCapCents}`
- `POST /api/paypal/vault/setup-token → {id}` · `POST /api/paypal/vault/confirm {setupTokenId} → {vaultId}` · `POST /api/paypal/vault/simulate` (mock)
- `POST /api/paypal/onboard → {actionUrl}` · `GET /api/paypal/onboard/return` (redirects to /seller/settings) · `POST /api/paypal/webhook`

Seller [INTEGRATIONS]:
- `GET /api/seller/products` · `POST /api/seller/products {draft}` · `PATCH /api/seller/products/:id {...guardrail/price/stock fields}`
- `GET /api/seller/deals → {deals:[{offerId, requestId, requestTitle, buyerName, status, unitPriceCents, quantity, totalCents, budgetMaxCents, competingOffers, updatedAt}]}`
- `GET /api/seller/settings` · `PATCH /api/seller/settings {paypalMerchantId?, autoDeal?, displayName?, tagline?}`
- `POST /api/shopify/connect {domain, token}` · `POST /api/shopify/import → {imported}`

## 6. Cross-module TS interfaces (foundation creates stubs with these exact signatures; owners implement)
```ts
// src/integrations/channel3.ts            [INTEGRATIONS]
export async function searchMarket(q: { query: string; quantity: number; maxTotalCents?: number; limit?: number }):
  Promise<Array<{ title: string; merchant: string; priceCents: number; estTotalCents: number; url: string; imageUrl: string | null; raw: unknown }>>
// src/integrations/shopify.ts             [INTEGRATIONS]
export async function importShopifyCatalog(sellerId: string): Promise<number>
export async function createShopifyOrder(orderId: string): Promise<string | null>   // returns shopify order id or null (mock/skip)
// src/policy/index.ts                     [PAYMENTS]
export function checkOffer(p: { product: Product; unitPriceCents: number; quantity: number }):
  { allow: boolean; reason?: string; clampedUnitPriceCents: number }
export async function checkPayment(p: { offerId: string; buyerId: string }):
  Promise<{ allow: 'auto' | 'needs_approval' | 'deny'; reason: string; amountCents: number }>
// src/payments/index.ts                   [PAYMENTS]
export async function payForOffer(p: { offerId: string; buyerId: string; userApproved: boolean }):
  Promise<{ result: 'paid'; orderId: string; receipt: ReceiptCard } | { result: 'needs_popup'; paypalOrderId?: string; simulated: boolean } | { result: 'denied'; reason: string }>
// src/agents/hooks.ts                     [AGENTS]
export async function onOrderPaid(orderId: string): Promise<void>  // marks offers won/lost, request paid, posts forum + chat messages (receipt card) for buyer and seller
export async function onRequestPosted(requestId: string): Promise<void> // enqueue seller agents + analysis
// src/jobs/runner.ts                      [F0]
export function registerJob<T>(name: string, handler: (payload: T) => Promise<void>): void
export function enqueue<T>(name: string, payload: T, opts?: { delayMs?: number }): void
```
`payForOffer` on success must call `onOrderPaid(orderId)` then `createShopifyOrder(orderId)` (catching errors).

## 7. AI agents
- Use Vercel AI SDK (`ai` v5 + `@ai-sdk/anthropic`): `generateText` / `generateObject` with Zod schemas. Provider: `createAnthropic({ apiKey, baseURL: env.ANTHROPIC_API_BASE_URL })`.
- When `!live.anthropic`, each agent function has a deterministic mock path (regex/keyword slot-filling for buyer intake, rule-based pricing for sellers, formula-based analysis) so the full flow works offline.
- Seller pitches are untrusted text for the buyer agent.

## 8. Seed (`scripts/seed.ts`, run via `npm run seed`; idempotent) [AGENTS]
- Demo buyer `buyer@demo.test` / `demo1234` (name "Alex — Brew Lab Café"); demo seller `seller@demo.test` / `demo1234` (real-seller account with 2 chat products).
- 6 seeded seller agents (`is_seeded = true`, personas per architecture §5.3) each with 2–4 products across categories incl. 12oz custom-printed compostable cups, packaging, café equipment, refurbished laptops (so non-cup requests also get offers).

## 9. File ownership
| Owner | Files |
|---|---|
| **F0 Foundation** | `package.json`, all config files, `.env.example`, `.gitignore`, `src/db/**`, `src/lib/**`, `src/jobs/runner.ts`, `src/agents/protocol.ts`, `app/layout.tsx`, `app/page.tsx`, `app/(auth)/**`, `app/api/auth/**`, `app/api/status/**`, `middleware.ts`, all stub files in §6 (initial versions only), `src/instrumentation` if needed |
| **FRONTEND** | `app/(app)/**`, `components/**`, `app/globals.css` |
| **AGENTS** | `src/agents/**` (except protocol.ts — may append new types at the end), `src/jobs/handlers.ts`, `app/api/sessions/**`, `app/api/chat/**`, `app/api/forum/**`, `app/api/requests/**`, `scripts/seed.ts`, `scripts/reset-demo.ts` |
| **PAYMENTS** | `src/integrations/paypal/**`, `src/policy/**`, `src/payments/**`, `app/api/paypal/**`, `app/api/offers/**`, `app/api/buyer/**`, `tests/policy*` |
| **INTEGRATIONS** | `src/integrations/channel3.ts`, `src/integrations/shopify.ts`, `app/api/seller/**`, `app/api/shopify/**` |

## 10. Pages (FRONTEND)
- `/login`, `/signup` (F0, simple but styled).
- `/(app)` layout: left sidebar (sessions list + "New session", wallet/limits summary for buyers, PayPal/Shopify status for sellers, integration mode badges from `/api/status`), main canvas.
- `/s/[sessionId]?tab=chat|forum|offers` (buyer) and `?tab=chat|forum|deals` (seller).
- `/forum` (global), `/seller/catalog` (AG Grid editable), `/seller/settings` (PayPal connect, Shopify connect, auto-deal), `/buyer/settings` (link PayPal, limits).
- AG Grid v34: register `AllEnterpriseModule` from `ag-grid-enterprise` (watermark OK without key), theme Quartz via `themeQuartz`.

## 11. Foundation reality (as built by F0)
- Versions: next 15.5, react 19, typescript 5.9, tailwind 4 (`@tailwindcss/postcss`), drizzle-orm 0.45 / drizzle-kit 0.31, @electric-sql/pglite 0.5, postgres 4, **zod 3.25** (works with ai v5), ai 5 + @ai-sdk/anthropic 2, **ag-grid-* 36.3** (all three same version; `AllEnterpriseModule` + `themeQuartz` API unchanged from v34), @paypal/react-paypal-js 10, @tanstack/react-query 5, lucide-react, clsx, date-fns 4, bcryptjs 3, tsx, vitest 4.
- Path alias `@/*` → repo root: `@/src/db`, `@/src/lib/auth`, `@/components/...`.
- `src/lib/env.ts`: `env` (typed, defaults applied, never throws), `live` {anthropic, paypal, channel3, shopify}, `integrationStatus()`. `live.paypal` needs both client id + secret. `live.shopify` = `SHOPIFY_TOKEN_ENC_KEY` set to something other than the dev default (Shopify creds are per seller). Client code reads `process.env.NEXT_PUBLIC_*` directly.
- `src/lib/http.ts`: `HttpError(status, message, details?)`, `badRequest/unauthorized/forbidden/notFound(msg?)`, `json(data, status|init?)`, `handle(fn)` (HttpError → `{error, details}` + status; ZodError → 400 `{error:"Invalid input", issues}`; other → 500), `readJson(req, zodSchema)`.
  Pattern: `export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => { const user = await requireUser("buyer"); const { id } = await params; ...; return json({...}); });`
- `src/lib/auth.ts`: `SESSION_COOKIE`, `getCurrentUser(): Promise<User|null>`, `requireUser(role?): Promise<User>` (401/403 HttpError), `createUser({email,password,name,role})` (also inserts buyer/seller profile; 409 on dup), `authenticate(email,password)`, `createSession(userId)`, `destroySession()`, `getUserBySessionToken(token)`, `hashPassword`, `verifyPassword`, `toPublicUser(u)` → `{id,email,name,role}` (never return `passwordHash`). Emails are lower-cased. Seed scripts should use `createUser`-equivalent inserts with `hashPassword` (note `createUser` itself is fine outside a request; `createSession` is not, it sets a cookie).
- `src/jobs/runner.ts`: `registerJob`, `enqueue` (setTimeout; errors logged), `loadHandlers()`. `src/jobs/handlers.ts` (AGENTS) registers at module top level; it is imported on server start by `instrumentation.ts` and lazily before every job run, so handlers never miss registration.
- `src/agents/protocol.ts`: `RequestSpecSchema/RequestSpec`, `OfferInputSchema/OfferInput`, `CounterSchema/Counter`, `RecommendationSchema/Recommendation`, `ProductDraftSchema/ProductDraft`, per-card schemas + types (`RequestSummaryCard`, `ProductConfirmCard`, `RecommendationCard`, `ReceiptCard`, `StatusCard`), `CardSchema/Card` (discriminated on `type`), `Message` (API shape: `{id, sessionId, role, content, card, createdAt: ISO string}`), `MessageRole`. `ReceiptCard.paypalOrderId` is `string | null` (null in simulated mode).
- `src/payments/index.ts` also exports `type PayForOfferResult`; `src/integrations/channel3.ts` exports `type MarketResult`.
- `components/providers.tsx` (React Query `QueryClientProvider`, mounted in `app/layout.tsx`) and `components/auth-form.tsx` (used by `/login` + `/signup`) were created by F0; FRONTEND owns `components/**` and may restyle them. `app/(app)/layout.tsx` and `app/(app)/home/page.tsx` are placeholders for FRONTEND.
- `middleware.ts` redirects to `/login?next=…` when the `aa_session` cookie is absent for any non-API page except `/login`, `/signup`. API routes must check auth themselves (`requireUser`).
- Scripts: `dev` / `start` (port 3000), `build`, `typecheck`, `test` (vitest; `tests/**/*.test.ts`, `src/**/*.test.ts`), `seed`, `reset-demo` (tsx, loading `.env` + `.env.local`), `db:generate`. Local env file: `.env.local` (copy of `.env.example`).

## 14. Payments notes (PAYMENTS)
**Modules**
- `src/integrations/paypal/` (server-only): `client.ts` (sandbox base `https://api-m.sandbox.paypal.com`, or prod if `PAYPAL_ENV=live`; cached OAuth client-credentials token; `paypalFetch<T>(path, {method, body, requestId, ...})` adds `PayPal-Request-Id` + `PayPal-Partner-Attribution-Id` = `PAYPAL_BN_CODE` when set; throws `PayPalError` with status, name, issues and `debug_id`; `centsToValue`/`valueToCents`), `orders.ts` (Orders v2 create/capture/get, `createOrderWithFallbacks`), `vault.ts` (Vault v3 setup/payment tokens), `partners.ts` (Partner Referrals + merchant-integrations), `webhooks.ts` (signature verification). `index.ts` re-exports everything plus `getPayPalOrderStatus(paypalOrderId)` (live-only, null in mock).
- **For AGENTS:** `@paypal/agent-toolkit` is NOT installed, so there are no toolkit tools. Use `getOrderStatus(idOrPaypalOrderId)` from `@/src/payments` instead (accepts our order id or a PayPal order id, works in mock mode) → `{orderId, status:'created'|'paid'|'failed'|'unknown', mode, amountCents, paypalOrderId, paypal: {status, captureId, captureStatus, payeeMerchantId, ...}|null}`.
- Also exported from `@/src/payments`: `buildReceipt(orderId)`, `finalizePaid`, `isSimulatedVault`, `SIMULATED_VAULT_PREFIX`. From `@/src/policy`: `checkOffer`, `checkPayment`, plus the pure helpers `evaluatePayment`, `minAllowedUnitPriceCents`, `computeOfferTotalCents`, `platformFeeCents`.

**Policy semantics**
- `checkOffer`: clamped price = max(asked, floor, ceil(list × (100 − maxDiscountPct)/100)). Below the minimum is NOT a deny: `allow:true`, `reason` explains the clamp, and the seller agent should offer `clampedUnitPriceCents`. Deny (`allow:false`) only for inactive product, qty ≤ 0, qty > stock, qty > `max_qty_per_order`. MOQ is not enforced.
- `checkPayment` → `deny` when: offer missing; request not this buyer's; request already has a paid order or is `paid`; request status not in `open|analyzing|recommended|approved`; offer status not in `active|countered|revised|won`; stored `total_cents` ≠ unit×qty+shipping; seller has no `paypal_merchant_id` (**live mode only**; mock mode doesn't need merchant ids). `auto` when a vault is linked AND amount ≤ auto_pay_limit AND spent_this_month + amount ≤ monthly_cap; otherwise `needs_approval`. `amountCents` is always the recomputed total.

**payForOffer behaviour** (one order row per offer; a paid offer returns its existing receipt as `paid`)
- `deny` → `{result:'denied', reason}`.
- `needs_approval` + `userApproved:false` (agent acting alone) → `{result:'denied', reason:'Needs your approval: …'}`. Agents should show that reason and an "Approve & pay" button.
- `needs_approval` + `userApproved:true` → `{result:'needs_popup', simulated: !live}`. Over-limit payments are never charged silently to the vault: the buyer confirms in PayPal.
- `auto` → charges the vault: in live mode, an order with `payment_source.paypal.vault_id`, captured if not already `COMPLETED`; in mock mode, paid instantly. Returns `{result:'paid', orderId, receipt}` with `receipt.mode = 'vault'` (`paypalOrderId` is null in mock). If PayPal rejects the vault charge with a 4xx, it falls back to `needs_popup`.
- `userApproved:true` writes an `approvals` row. Every decision is logged to `agent_events` (actor `payments`, tools `check_payment`, `payment_captured`, `payment_failed`).
- On every successful payment, `finalizePaid` runs once even if capture and webhook race: order → `paid`, `spent_this_month_cents += amount`, then `onOrderPaid(orderId)`, then `createShopifyOrder(orderId)` (its return value is stored in `orders.shopify_order_id`). Errors in either call are caught and logged.
- Platform fee = `round(amount × PLATFORM_FEE_BPS / 10000)` only when `seller.platform_fee_enabled`. The fee is recorded in simulated mode too. If PayPal rejects the order with the fee, it retries without `platform_fees` and records fee 0 (logged as a warning).
- Popup orders also ask PayPal to save the wallet (`attributes.vault.store_in_vault: "ON_SUCCESS"`, `usage_type: PLATFORM`, override with `PAYPAL_VAULT_USAGE_TYPE=MERCHANT`, disable with `PAYPAL_VAULT_ON_POPUP=0`). If PayPal rejects that, the order is retried without it. A vault id returned on capture is stored on `buyer_profiles`, so the first popup payment enables auto-pay.

**Routes (as built, all `requireUser` except webhook and onboard/return)**
- `POST /api/offers/:id/approve` (buyer) → 200 `paid` | `needs_popup`; **409** `{result:'denied', reason, error}`.
- `POST /api/paypal/orders {offerId}` → `{id}`. Live only (400 in mock). Reuses a still-open PayPal order for the offer.
- `POST /api/paypal/orders/:paypalOrderId/capture {offerId}` → `{orderId, receipt}`. 402 if not completed; idempotent.
- `POST /api/paypal/simulate-pay {offerId}` → `{orderId, receipt(mode 'simulated')}`. Mock only (400 when live). Idempotent.
- `GET /api/buyer/settings` → `{autoPayLimitCents, monthlyCapCents, spentThisMonthCents, remainingThisMonthCents, paypalLinked, vaultSimulated, paypalMode:'live'|'mock'}` (flat, not wrapped). `PATCH {autoPayLimitCents?, monthlyCapCents?, unlinkPaypal?: true}` → same shape.
- `POST /api/paypal/vault/setup-token` → `{id, approveUrl, simulated}`. Use `id` in the JS SDK `createVaultSetupToken`; mock returns `SIMULATED-SETUP-…`. `POST /api/paypal/vault/confirm {setupTokenId}` → `{vaultId, simulated}`. `POST /api/paypal/vault/simulate` → `{vaultId:'SIMULATED-VAULT-…'}`, mock only (400 when live).
- `POST /api/paypal/onboard` (seller) → `{actionUrl, simulated}`. Live: partner referral with `tracking_id` = seller user id, return URL `APP_URL/api/paypal/onboard/return`, status set to `pending`. Mock: sets merchant id `SIMULATED-MERCHANT-xxxx`, status `complete`, fee enabled, and `actionUrl=/seller/settings?onboarded=1`.
- `GET /api/paypal/onboard/return?merchantId=<tracking>&merchantIdInPayPal=…` → redirects to `/seller/settings?onboarded=1|pending|0&error=…`. Live with `PAYPAL_PARTNER_MERCHANT_ID`: checks via merchant-integrations that the tracking id matches, then `complete` if `payments_receivable && primary_email_confirmed`, and `platform_fee_enabled` if the `partnerfee` scope was granted. Without a partner id, or in mock mode, only the signed-in seller can update themself.
- `POST /api/paypal/webhook`: ignored in mock mode. Verifies the signature when `PAYPAL_WEBHOOK_ID` is set. Handles `PAYMENT.CAPTURE.COMPLETED` (re-reads the order from PayPal before marking paid), `PAYMENT.CAPTURE.DENIED/DECLINED` (order → failed), `MERCHANT.ONBOARDING.COMPLETED` (re-checked via merchant-integrations) and `MERCHANT.PARTNER-CONSENT.REVOKED`. Deduplicated per event id via `agent_events` (actor `paypal_webhook`).

**Frontend wiring (live)**: `<PayPalButtons createOrder={() => POST /api/paypal/orders {offerId} → id} onApprove={({orderID}) => POST /api/paypal/orders/${orderID}/capture {offerId}} />` with `NEXT_PUBLIC_PAYPAL_CLIENT_ID`. For Multiparty, the SDK script may need `merchant-id`/`data-partner-attribution-id` options; verify in sandbox. Save without purchase: `<PayPalButtons createVaultSetupToken={() => POST /api/paypal/vault/setup-token → id} onApprove={({vaultSetupToken}) => POST /api/paypal/vault/confirm {setupTokenId: vaultSetupToken}} />`. Mock mode: show "Pay (simulated)" → `/api/paypal/simulate-pay` and "Link PayPal (simulated)" → `/api/paypal/vault/simulate`.

**Env vars**: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (both set = live), `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (same client id), `PAYPAL_PARTNER_MERCHANT_ID` (platform account's merchant id, needed for merchant-integrations), `PAYPAL_BN_CODE` (partner attribution id), `PLATFORM_FEE_BPS` (default 300), `APP_URL`. Optional (read via `process.env`, not in `env.ts`, F0 may add them to `.env.example`): `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV=live` (production base URL), `PAYPAL_VAULT_USAGE_TYPE` (`PLATFORM`|`MERCHANT`), `PAYPAL_VAULT_ON_POPUP=0`.

**Sandbox setup (step by step)**
1. Go to https://developer.paypal.com and log in. Open Apps & Credentials, switch to **Sandbox**, then Create App → type **Platform** (Multiparty) → copy the Client ID and Secret into `.env.local` as `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`. In the app's features, enable **Vault** (Advanced options) and **Accept payments**.
2. Open Testing Tools → Sandbox Accounts. The default sandbox **business** account belongs to the platform; open it and copy its Account ID (merchant id) into `PAYPAL_PARTNER_MERCHANT_ID`. Set `PAYPAL_BN_CODE` to the BN code PayPal gives your partner account (it can stay empty in sandbox, since the header is only sent when set).
3. Create **one sandbox business account per seeded seller** (6, plus `seller@demo.test`): Create account → Business → US. Open each one → copy its **Account ID** → put it in `seller_profiles.paypal_merchant_id` (the AGENTS seed, or the seller's PATCH `/api/seller/settings {paypalMerchantId}`). In live mode, sellers without a merchant id cannot be paid (the policy denies). To test real onboarding instead, sign in as a seller and use "Connect PayPal" (`/api/paypal/onboard`), completing the flow with a fresh sandbox business account.
4. Create a sandbox **personal** (buyer) account with a balance (e.g. $5,000). Use its email and password in the PayPal popup during the demo.
5. Optional webhooks: in the app → Webhooks → add `https://<public-url>/api/paypal/webhook` (localhost needs a tunnel such as ngrok) with the events PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED, MERCHANT.ONBOARDING.COMPLETED and MERCHANT.PARTNER-CONSENT.REVOKED. Copy the Webhook ID into `PAYPAL_WEBHOOK_ID`. The demo does not depend on webhooks, because capture updates state synchronously.
6. Restart `npm run dev`; `/api/status` should show `paypal: "live"`. First payment: the buyer pays one offer through the popup, which also saves the wallet if the sandbox allows it. Later offers under the auto-pay limit are paid by the agent through the vault.
7. Known risks, untested without keys: (a) whether `usage_type: PLATFORM` vaulting is enabled for sandbox platform apps (if it is rejected, set `PAYPAL_VAULT_USAGE_TYPE=MERCHANT`, though merchant-level vault ids may not work across different payees, in which case auto-pay falls back to the popup); (b) platform fees need the seller to have granted the PARTNER_FEE permission, which manually created sandbox accounts haven't, so expect the fee to be dropped to 0 with a warning unless the seller onboarded through partner referrals and `platform_fee_enabled` is true.

## 15. Integrations notes (INTEGRATIONS)
**Channel3 — `searchMarket` (`src/integrations/channel3.ts`)**
- Live: `POST https://api.trychannel3.com/v1/search` with `x-api-key: CHANNEL3_API_KEY`, body `{query, limit}` (+ `filters.price.max_price` in dollars only when quantity = 1). Mapping: `title` ← `products[].title`; offer = cheapest in-stock USD `products[].offers[]`; `merchant` ← offer `domain` (amazon.com → "Amazon" etc., else domain, else brand); `url` ← offer `url`; `imageUrl` ← main `images[].url`.
- **Pack normalisation**: pack size is detected from the title ("Pack of 50", "1000/Case", "250 pcs", "100 Count", "50 cups/Pack"). `priceCents` = **per-unit** price (listed ÷ pack size); `estTotalCents` = ceil(quantity ÷ pack) × listed price (you buy whole packs). `raw` = `{source:'channel3'|'mock', listedPriceCents, packSize, packsNeeded, currency, availability, ...}`. Results sorted by `estTotalCents` asc. Never throws (returns `[]`, logs). Live results cached in memory 1h by sha256 of (query, quantity, maxTotal, limit); mock results are deterministic so not cached.
- Mock: 5–8 listings per query, stable per query string, by keyword category (cups, lids, bags/packaging, laptops → refurb retailers, coffee beans, café equipment, furniture, generic). Cup retail per-unit ≈ $0.17–0.70, i.e. mostly above bulk forum offers (~$0.12–0.20). Example "500 custom printed 12oz compostable cups" → Costco 300 ct (17¢/u, est $104.18 for 2 packs), Amazon 50-pack (28¢), Amazon custom 500-pack (34¢), WebstaurantStore 1000/case (19¢, est $186.69), Etsy custom 250 pcs (65¢).
- Getting a key: sign up at https://trychannel3.com/sign-up/developer (free tier: 1,000 searches/month, no card), copy the API key into `.env.local` `CHANNEL3_API_KEY=`, restart dev server. Docs: https://channel3.ai/docs/api-reference/v1/search.

**Shopify (`src/integrations/shopify.ts`)** — Admin GraphQL API version **`2026-10`** (latest stable as of Nov 2026). Live vs demo is decided **per seller connection**, not by `live.shopify`:
- Demo: domain `demo.myshopify.com` **or** token `demo` → connect succeeds offline (`shopName` "Bean & Box Supply Co. (demo)"), import creates 4 café-packaging products (12oz custom-printed compostable cup 19¢ MOQ 500, CPLA sip lid 6¢, kraft valve coffee bag 42¢, molded-fiber 4-cup carrier 28¢), `createShopifyOrder` returns `gid://shopify/Order/DEMO-XXXXXXXX`.
- Token stored as `v1:iv:tag:ciphertext` (AES-256-GCM, key = sha256(`SHOPIFY_TOKEN_ENC_KEY`)). Changing the env key orphans stored tokens (seller must reconnect). Token never leaves the server.
- The `token` field accepts either an Admin API access token (`shpat_…`) or `clientId:clientSecret` of a Dev Dashboard app; the latter is exchanged via the client-credentials grant (`POST https://{shop}/admin/oauth/access_token`, 24h token, cached in memory). Client credentials only work for stores in the same Shopify organization as the app.
- `importShopifyCatalog(sellerId)`: up to 5×50 active products × 50 variants; one `products` row per variant (`source:'shopify'`, title "Product — Variant" unless "Default Title", price from variant, stock = `inventoryQuantity` ≥ 0, category = productType, image = featuredMedia). Upsert by `(seller_id, shopify_variant_id)`; new rows floor = 85% of price, max discount 15; re-import refreshes title/desc/price/stock/image but **keeps seller guardrails** (floor clamped to ≤ new price). Returns count upserted. Returns 0 if not connected; throws `ShopifyError` on API failure (route maps to 502).
- `createShopifyOrder(orderId)`: null unless the offer's product is `source:'shopify'` with a variant id and the seller is connected; idempotent (returns existing `orders.shopify_order_id`). Live: `orderCreate` with `lineItems:[{variantId, quantity, priceSet}]` (negotiated unit price), `shippingLines` if shipping > 0, `financialStatus: PAID`, `note: "OpenQuote order … · PayPal order …"`, tags `openquote,paypal`, `sourceIdentifier` = our order id, options `inventoryBehaviour: DECREMENT_OBEYING_POLICY, sendReceipt:false`. Stores the id on `orders.shopify_order_id`. Never throws (null + log).
- Extra exports for other modules: `connectShopify`, `disconnectShopify`, `getConnection(sellerId)` → `{domain, token, mode}|null`, `normalizeDomain`, `SHOPIFY_API_VERSION`, `DEMO_DOMAIN`.
- **Setting up a real dev store today**: legacy "Develop apps" custom apps can no longer be created (existing ones still work). (1) Create a free Shopify Partner / dev account → Dev Dashboard (https://dev.shopify.com) → create a **dev store**. (2) In the Dev Dashboard create an app, create a version with Admin API scopes `read_products, read_inventory, write_orders`, release it, and install it on the dev store. (3) Copy the app's Client ID + Client secret and paste `clientId:clientSecret` as the token in /seller/settings with domain `your-store.myshopify.com` (or run any OAuth flow / Shopify CLI to get an offline `shpat_` token and paste that). (4) Add a few products with inventory, then "Import". Note: orders endpoints may require protected-customer-data approval for some fields; we don't send customer data.

**Seller API (as built)**
- `GET /api/seller/products → {products: Product[]}` (newest first). `POST /api/seller/products {draft, messageId?}` (bare draft also accepted) → 201 `{product}`; draft = `ProductDraft` + optional `maxQtyPerOrder`, `imageUrl`; 400 if floor > price. If `messageId` is the seller's own `product_confirm` card message, the card gets `savedProductId` written.
- `PATCH /api/seller/products/:id` fields: `unitPriceCents, stock, floorPriceCents, maxDiscountPct, maxQtyPerOrder (null ok), active, title, description, category, moq, leadTimeDays`; unknown keys are stripped (send a whole AG Grid row if convenient); 404 for other sellers' products; 400 if merged floor > price. → `{product}`.
- `GET /api/seller/deals` → contract fields plus `requestStatus, deadline, productId, productTitle, version, shippingCents, etaDays`; `competingOffers` = other sellers' non-withdrawn offers on that request (no prices).
- `GET /api/seller/settings → {settings: {displayName, tagline, rating, isSeeded, paypalMerchantId, onboardingStatus, platformFeeEnabled, autoDeal, shopify:{connected, domain, mode:'live'|'demo'|null}, productCounts:{total, active, chat, shopify, seed}}}`. `PATCH` same body as contract (alphanumeric `paypalMerchantId`; set → onboarding 'complete', null/"" → 'none') → `{settings}`.
- `POST /api/shopify/connect {domain, token}` → `{connected:true, domain, shopName, mode}`; domain accepts `my-store`, `my-store.myshopify.com`, or a full URL; bad creds/unknown store → 400 with Shopify's message; network error → 502. `DELETE /api/shopify/connect → {connected:false}` (keeps imported products). `POST /api/shopify/import → {imported}` (400 if not connected).

## 12. Agents notes (AGENTS)
**Additive API fields / behaviour (no breaking changes)**
- `POST /api/requests/:id/post` accepts an optional body `{windowSeconds?: 10–3600}` that overrides `OFFER_WINDOW_SECONDS` (useful for demos and tests). Returns `{request, messages}`. It also sets `posted:true` on the request's `request_summary` card in place.
- `PATCH /api/requests/:id {spec}` accepts a **partial or full** spec, merges it into the existing one and validates it. Drafts only (400 otherwise). It updates the summary card in place. Also `GET /api/requests/:id → {request}`.
- Chat: in a draft session, saying "post it", "yes" or "go ahead" publishes the request, the same as the button. After posting, "extend" reopens the window when there were no offers.
- `GET /api/sessions` rows also carry `createdAt`, `requestId`, `requestStatus`. Badges: `new`, `draft`, `collecting[ · N offers]`, `analyzing`, `N offers · pick ready`, `no offers`, `approved`, `paid ✓`. A seller's latest session shows `N live deals` or `N sold ✓ · M live`.
- `GET /api/forum` rows: `{id,title,status,spec,windowEndsAt,createdAt,buyerName,offerCount,mine}`. Sellers also get `match?:{productId,productTitle,confidence}`, `replied`, `myOfferId`, `myOfferStatus`, and the list is sorted by match. `?status=open` filters by status.
- `GET /api/forum/:requestId`: `request` has `{…, deadline, location, budgetMaxCents, buyerName, offerCount, mine}`. Each post has `authorName` ("Alex's agent", "EcoCup Co. agent", "OpenQuote") and `offer` (the structured chip: unit, qty, shipping, total, eta, warranty, returnPolicy, status, version) or null.
- `GET /api/requests/:id/offers` (buyer owner only): each offer also has `paymentsReady`, and the response also has `request:{id,status,windowEndsAt,deadline,budgetMaxCents}`. Offers are sorted by `aiScore` desc. Listings are sorted by est total.
- **`ai_score` and `spec_match` are on a 0–100 scale.** Flags are human-readable strings: `price N% below market|other offers` (suspicious: never the top pick), `no return policy`, `ETA Xd after deadline (Yd left)`, `quantity short (q/n)`, `seller payment setup pending`, `over budget by $X`, `vague terms`.
- `Recommendation.savingsVsMarketCents` = best **comparable** Channel3 listing est. total (titles covering ≥60% of the must-haves, otherwise all listings) minus the top offer's total. It can be negative. `reasons` has one entry for every offer, not just the shortlist.
- Status-card messages carry the same text in `content`. Background-job messages use strictly increasing `createdAt` (ms), so `?after=<last createdAt>` polling never skips or repeats.
- Forum post types used: `request`, `offer`, `question` (LocalKL asks first), `answer` (buyer agent answers from the spec, and also a seller's decline of a counter), `counter`, `revision`, `system` (window closed / analysis done / deal closed / seller's thank-you).
- `onOrderPaid`: winner → `won`, others → `lost`. Request goes `paid`, then `closed` once the receipt card is posted. Product stock is decremented. Forum gets a system post plus the winner's thank-you post. The buyer chat gets the receipt card. Each seller chat gets "Sold" (success) or "not selected". Idempotent.
- Seller chat sessions are created on demand (`getOrCreateSellerSession`) for agent status messages.

**Dev / seed**
- `POST /api/dev/seed` (idempotent upsert) and `POST /api/dev/reset` (clears requests, cascading to offers/posts/orders/approvals/listings, plus chat sessions and agent_events; resets `spent_this_month`; keeps users and products; re-seeds). No auth, so dev only. `src/jobs/handlers.ts` calls `seedIfEmpty()` on load, so a fresh DB seeds itself on server start. `npm run seed` / `npm run reset-demo` call the same functions but only work while the dev server is stopped.
- Seeded logins (password `demo1234`): `buyer@demo.test`, `seller@demo.test` (Kopi Supply Co., PayPal **not** connected, so it demos onboarding and gets the "payment setup pending" flag), and `ecocup@ / printpal@ / bulkbarn@ / hagglehouse@ / dealznow@ / localkl@seed.test` (merchant ids `SEEDMERCHANT1..6`, onboarding complete).
- Cup prices are tuned to INTEGRATIONS' mock Channel3 data: forum offers run about $0.26–0.40 per cup. The demo outcome: EcoCup is the top pick after a counter (~$145), HaggleHouse concedes $0.31 → $0.27, DealzNow ($35) is flagged, BulkBarn misses the deadline, and LocalKL asks a question.

**Agents internals**: everything is logged to `agent_events`. Actors: `buyer_agent`, `seller_agent:<id>`, `system`. Tools include `intake_state`, `update_request_draft`, `post_request`, `match_request`, `ask_question`, `answer_seller_question`, `check_offer`, `make_offer`, `search_market`, `score_offers`, `send_counter`, `respond_to_counter`, `recommend`, `order_paid`. LLM calls go through `withLLM` in `src/agents/llm.ts`: mock when there's no key, otherwise retry once and then fall back to mock. Seller text is marked untrusted in every prompt, and the LLM never triggers tools: prices and decisions are clamped and made in code.
- **Top-pick rule (enforced in code, `recommend()` in `src/agents/buyer/analyze.ts`):** offers are sorted by risk tier first, then by `aiScore`. The tiers come from `riskTier(flags)` in `score.ts`:
  - 0 = no flags
  - 1 = only soft flags (no return policy, over budget, quantity short, LLM-added flags)
  - 2 = hard flags (ETA after deadline, seller payment setup pending, vague terms)
  - 3 = price far below market or other offers
  
  `topOfferId` comes from the lowest tier that has any offers, so a flagged offer is only the top pick if every offer is flagged. Alternatives follow the same order.
- `GET /api/forum/:requestId` posts: `offer` (the current offer state) is present on every post with an `offerId`: `offer`, `counter`, `revision`, and a seller's declining `answer`. Any signed-in user, sellers included, can see it. New fields:
  - `original` on `offer` posts: `{unitPriceCents, quantity, shippingCents, etaDays, totalCents}` as first offered, so the UI can show "was $0.31 → now $0.27".
  - `counter` on `counter` posts: `{targetUnitPriceCents, targetEtaDays}`, what the buyer agent asked for.
  
  Both are null otherwise.
