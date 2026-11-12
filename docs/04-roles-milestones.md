# OpenQuote — Roles, Tasks & Milestones

Related: [Plan](01-plan.md) · [User flow](02-user-flow.md) · [Architecture](03-architecture.md)

**All times GMT+8.** Devpost deadline: **Fri Nov 13, 04:00**. Internal submission: **Thu Nov 12, 18:00**.

---

## 1. Roles

| Role | Owns | Main files |
|---|---|---|
| **R1 — Frontend & AG Grid** | App shell (sidebar + canvas tabs), chat UI, forum UI, all AG Grid views, PayPal button UI, visual polish | `app/(app)/*`, `components/*` |
| **R2 — AI agents** | Buyer agent (intake, analysis, scoring, negotiation, recommendation), seller agent runner and personas, prompts, protocol schemas | `src/agents/*`, `src/jobs/*`, `worker/*` |
| **R3 — Payments & integrations** | PayPal (Orders, Multiparty, Vault, Partner Referrals, webhooks, Agent Toolkit), policy engine, Channel3, Shopify | `src/integrations/*`, `src/policy/*`, `app/api/paypal/*`, `app/api/shopify/*` |
| **R4 — Platform, data & demo** | Repo, auth, DB schema, seed and reset scripts, Render deploy, README, demo script, video, Devpost write-up | `src/db/*`, `scripts/*`, `render.yaml`, `README.md` |

**If you are 3 people:** R4's platform tasks (auth, DB, deploy) go to R3; seed data goes to R2; README, video and Devpost go to R1.
**If you are 2 people:** **A = R1 + R4** (everything user-facing + demo), **B = R2 + R3** (everything backend). Cut negotiation and Partner Referrals from P1 up front.

---

## 2. Contracts to agree on Day 0 (so everyone can work in parallel)

These must be merged **before** parallel work starts (target: Mon 23:00). Owners in brackets.

1. `src/agents/protocol.ts`: Zod schemas for RequestSpec, Offer, Counter, Question, Answer **[R2]**
2. `src/db/schema.ts`: all tables from architecture §4 **[R4]**
3. API route list with request/response types (`requests`, `offers`, `forum`, `paypal/*`, `shopify/*`) **[R3 + R1]**
4. Policy engine signature: `checkPayment(ctx) → {allow, reason}` and `checkOffer(ctx) → {allow, reason, clampedPrice?}` **[R3]**
5. `fixtures/demo.json`: one request, 6 offers, 6 Channel3 listings, so R1 can build the grids before the agents work **[R2]**

---

## 3. Milestones

| # | When | Milestone | Exit criteria |
|---|---|---|---|
| **M0** | Mon Nov 9, 23:59 | **Setup & contracts** | Repo + Next.js skeleton deployed to Render; DB migrated; all accounts and keys ready; contracts (§2) merged |
| **M1** | Tue Nov 10, 22:00 | **Spine on real LLM, payments spike done** | Buyer chat → request posted → seeded seller agents post offers → Offers grid shows them (polling). PayPal sandbox script pays a seller via `payee.merchant_id`. **Vault decision made: go or fallback.** |
| **M2** | Wed Nov 11, 22:00 | **P0 complete on Render** | Full buyer flow end-to-end in the hosted app incl. Channel3 rows, recommendation, PayPal payment; seller registers a product in chat and their agent auto-offers. P1 items in progress. |
| **M3** | Thu Nov 12, 12:00 | **Feature freeze** | P1 items either merged or cut (see §5). Only bug fixes and polish after this. |
| **M4** | Thu Nov 12, 18:00 | **Submitted** | Video on YouTube, README complete, repo public with license, Devpost submitted. Buffer until Fri 04:00. |

---

## 4. Tasks by role and milestone

IDs are for your tracker (F = frontend, A = agents, PY = payments & integrations, D = platform & demo). **Bold** = on the critical path for the demo.

### R1 — Frontend & AG Grid
| ID | Task | Milestone | Pri |
|---|---|---|---|
| F1 | **App shell: sidebar sessions + canvas with Chat / Forum / Offers tabs; seller variant** | M0–M1 | P0 |
| F2 | **Chat UI with AI SDK `useChat`; render cards (request summary, product card, recommendation, receipt)** | M1 | P0 |
| F3 | **Forum thread view: live posts, offer chips, author badges; global forum list** | M1 | P0 |
| F4 | **Offers grid (fixtures first): grouping by source, score bar, flag chips, deadline ✓/✗, pinned recommended row, live transactions** | M1 | P0 |
| F5 | **PayPal JS SDK button on recommendation card (createOrder / onApprove → our API)** | M2 | P0 |
| F6 | Seller catalog grid with editable guardrail cells; deals grid with status pipeline | M2 | P0 |
| F7 | Link-PayPal + spend-limit settings screen | M2 | P1 |
| F8 | Master-detail (offer thread + rationale) and price-vs-ETA chart | M3 | P1 |
| F9 | Polish pass: empty and loading states, dark theme, sidebar badges, animations when rows arrive | M3 | P0 |

### R2 — AI agents
| ID | Task | Milestone | Pri |
|---|---|---|---|
| A1 | **`protocol.ts` schemas + `fixtures/demo.json`** | M0 | P0 |
| A2 | **Buyer intake: slot-filling prompt + `update_request_draft`, `post_request` tools** | M1 | P0 |
| A3 | **Seller agent runner: match → price within range → `make_offer`; 6 personas; staggered delays** | M1 | P0 |
| A4 | **pg-boss jobs: `seller.consider`, `buyer.analyze` scheduled at window end** | M1 | P0 |
| A5 | **Buyer analysis: Channel3 call (via R3 client), LLM spec-match/flags/rationale, code-computed score** | M2 | P0 |
| A6 | **Recommendation tool + card payload; "$X vs public web" line** | M2 | P0 |
| A7 | Seller Q&A: seller agent asks, buyer agent answers or escalates to chat | M2 | P0 |
| A8 | Seller chat product registration (extract → confirm card → save) | M2 | P0 |
| A9 | Negotiation: `send_counter` (top 2, 1 round) + `respond_to_counter` within guardrails; re-score | M2–M3 | P1 |
| A10 | Prompt-injection hardening (seller text treated as untrusted) + scripted fallback offers if the LLM fails | M3 | P0 |

### R3 — Payments & integrations
| ID | Task | Milestone | Pri |
|---|---|---|---|
| PY1 | **Sandbox setup: Platform REST app, 1 platform + 6 seller business + 2 buyer personal accounts; BN code** | M0 | P0 |
| PY2 | **PayPal client (OAuth token cache) + `scripts/paypal-smoke.ts`: create → approve → capture with `payee.merchant_id`** | M1 | P0 |
| PY3 | **Spike: Vault save + buyer-not-present charge with payee = seller. Report go / fallback by M1** | M1 | P1 (decides scope) |
| PY4 | **Policy engine (`checkPayment`, `checkOffer`) + Vitest tests** | M1 | P0 |
| PY5 | **Payment API routes: `orders`, `capture`, idempotency, order + receipt records** | M2 | P0 |
| PY6 | **Channel3 client: search, cache, bulk price normalisation** | M1–M2 | P0 |
| PY7 | Vault auto-pay route `pay_for_offer` (if PY3 = go) | M2 | P1 |
| PY8 | Partner Referrals onboarding + status check + platform fee on orders | M2–M3 | P1 |
| PY9 | Shopify: dev store, app token, product import | M2 | P1 |
| PY10 | Shopify order write-back after capture | M3 | P1 |
| PY11 | Webhooks (capture completed/denied, onboarding completed) with signature verification | M3 | P1 |
| PY12 | Agent Toolkit read tools (order status) for the buyer agent | M3 | P1 |

### R4 — Platform, data & demo
| ID | Task | Milestone | Pri |
|---|---|---|---|
| D1 | **Repo, Next.js, Tailwind, shadcn, Drizzle, `.env.example`, MIT license** | M0 | P0 |
| D2 | **DB schema + migrations (architecture §4)** | M0 | P0 |
| D3 | **Better Auth: signup with buyer or seller role, login, route guards** | M0–M1 | P0 |
| D4 | **Render: web + worker + Postgres via `render.yaml`; deploy on every merge to main** | M0 | P0 |
| D5 | **`scripts/seed.ts` (6 sellers, catalogs, demo buyer) + `scripts/reset-demo.ts`** | M1 | P0 |
| D6 | API routes for sessions, requests, forum, offers (CRUD + polling endpoints) | M1 | P0 |
| D7 | README: problem, features, architecture diagram, setup from clean clone, demo accounts, tools used | M3 | P0 |
| D8 | Demo script rehearsal ×2, record video (≤ 2:50), edit, upload to YouTube (public) | M4 | P0 |
| D9 | Devpost write-up + screenshots; "Tools used" section mapping each tool to what it does | M4 | P0 |
| D10 | Ask AG Grid sponsor for a hackathon license key; ask Channel3 for credits if needed | M0 | P1 |

---

## 5. Day-by-day schedule

### Mon Nov 9 (tonight) → M0
- **Everyone (30 min):** read the 4 docs, confirm hero scenario, agree on contracts owners.
- R4: D1, D2, D4 (deploy "hello world" early; deploy problems on the last day are the most common hackathon failure).
- R3: PY1 accounts; start PY2.
- R2: A1 protocol + fixtures.
- R1: F1 shell against fixtures.
- **Get keys:** Anthropic, PayPal sandbox, Channel3, Shopify Partners dev store, Render, AG Grid (request).

### Tue Nov 10 → M1
- R2: A2, A3, A4: the agent loop works with real Claude calls.
- R1: F2, F3, F4 on fixtures, then switch to live API.
- R3: PY2, **PY3 spike (decide by 18:00)**, PY4, PY6.
- R4: D3, D5, D6.
- **20:00 integration check:** one person runs the full spine on Render. Fix blockers before sleeping.

### Wed Nov 11 → M2
- Morning: finish P0 (A5–A8, F5–F6, PY5).
- **14:00 P0 check:** full buyer + seller flow on Render. Nothing in P1 merges until this passes.
- Afternoon: P1 in this order: **PY7 Vault auto-pay → PY9 Shopify import → A9 negotiation → PY8 onboarding + fee → PY10 Shopify write-back → F7/F8**.
- R4: start README, write demo script, collect screenshots.

### Thu Nov 12 → M3, M4
- **Until 12:00:** finish or cut P1 items; F9 polish; A10 hardening.
- **12:00 feature freeze.** Bug bash: everyone runs the demo script twice on the hosted URL.
- **13:00–16:00:** record video (reset-demo before each take), edit, upload.
- **16:00–18:00:** README final check from a clean clone, Devpost text, submit.
- **After 18:00:** buffer only. Don't push risky changes.

---

## 6. Cut list (if behind, cut from the top)

1. All P2 items
2. F8 master-detail and chart
3. A9 negotiation
4. PY8 Partner Referrals + platform fee (keep pre-filled seller merchant IDs; mention onboarding in the video as "built-in flow, sandbox seeded")
5. PY10 Shopify write-back
6. PY11 webhooks (synchronous capture already updates state)
7. PY9 Shopify import
8. PY7 Vault auto-pay (popup approval stays)

**Never cut:** the P0 spine, the hosted URL, the README, the video.

---

## 7. Daily rhythm
- **10:00 standup (10 min):** yesterday, today, blockers, and whether we're on track for the next milestone.
- **20:00 integration check** on the Render URL, not localhost.
- `main` always deployable; short-lived branches; merge at least twice a day.
- One shared doc for keys and sandbox accounts (never in the repo).

## 8. Open decisions
| Decision | Owner | Needed by |
|---|---|---|
| Hero scenario (default: 500 custom cups) | Team | Mon 23:00 |
| Final product name | Team | Wed |
| Vault go / fallback | R3 | Tue 18:00 |
| AG Grid Enterprise key or accept watermark | R4 | Tue |
