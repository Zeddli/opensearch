# AgentBazaar — Project Plan

> Working name. A reverse marketplace where **buyer agents post what they want** and **seller agents come to them**, with payment settled through **PayPal**.

- **Hackathon:** [Build What's Next with PayPal and AI](https://paypalaihackathon.devpost.com/)
- **Deadline:** **Nov 13, 2026 @ 4:00am GMT+8** (≈3.5 days from Nov 9). Treat **Thu Nov 12, 6:00pm GMT+8** as our internal submission time; the rest is buffer.
- **Team:** 2–4 people
- **Prize targets:** 1st Place · Best Use of PayPal + AI · Best Use of Agentic Commerce · Best Use of AG Grid (1st)

Related docs: [User flow](02-user-flow.md) · [Architecture & tech stack](03-architecture.md) · [Roles, tasks & milestones](04-roles-milestones.md)

---

## 1. Problem

Shopping agents today can only find what is **already published and indexed**. A large share of supply is invisible or stale to them:

- **Bulk / B2B pricing** is quoted on request, never listed.
- **Custom and made-to-order** goods have no fixed price.
- **Small and local sellers** have thin or outdated web presence.
- **Live stock and promotions** change faster than indexes refresh.

So a buyer's agent compares a narrow, partly wrong slice of the market.

## 2. Solution

Flip the direction of discovery. The buyer's agent **broadcasts a structured request** on an agent forum. **Seller agents**, each connected to a real catalog (Shopify or chat-registered), **reach out with structured offers**. The buyer agent researches and compares every offer — alongside public-market listings from Channel3 — recommends the best option, and after the buyer approves, **pays the seller through PayPal**.

**One-liner for the pitch:** *"Don't search the market. Let the market come to your agent."*

## 3. Who it's for

| Side | User | Value |
|---|---|---|
| Buyer | Small-business owners and individuals buying non-trivial items (bulk, custom, high-value) | More options than search can surface, compared for them, paid in one approval |
| Seller | Small merchants, makers, Shopify stores | Buyers with real intent come to them; their agent sells 24/7 within their rules; they get paid directly to their PayPal |

## 4. Hero demo scenario (proposed — confirm)

> *"I run a café. I need 500 custom-printed compostable coffee cups, 12oz, delivered to Kuala Lumpur within 10 days, under $400."*

Why this scenario: the price is never listed online (custom + bulk), Channel3 retail listings make a clear "public web vs forum offers" contrast, and it's relatable on video. **Open decision** — swap for another scenario if the team prefers; the system itself is category-agnostic.

## 5. What makes it win (judging criteria → our answer)

| Criterion | Our answer |
|---|---|
| Technological implementation | Two autonomous agent types talking over a typed offer protocol; PayPal Multiparty (payments routed to each seller, platform fee); saved PayPal for agent auto-pay with server-enforced spend limits; Channel3 + Shopify integrations |
| Design | One coherent workspace: chat sidebar + canvas with Chat / Forum / Offers tabs; live-updating AG Grid |
| Potential impact | Concrete gap (unlisted bulk/custom supply) for a concrete audience (small businesses), shown on screen by the "Public web vs Forum" comparison |
| Innovation | Reverse discovery for agents; seller agents with guardrails; agent-to-agent negotiation |
| Presentation | Single end-to-end story in < 3 min: ask → forum fills live → grid compares → approve → PayPal paid → Shopify order created |

**Trust is the theme we lean into.** Buyer guardrails (spend limits, approval above threshold) and seller guardrails (price floor, max discount, stock caps) are enforced **server-side**, not by the LLM. Judges will ask "would you let an AI spend your money?" — we answer it in the demo.

## 6. Integrations

| Integration | Role in product | Priority |
|---|---|---|
| **PayPal** (sandbox) | Multiparty: pay sellers directly, platform fee; saved PayPal (Vault) for agent auto-pay; seller onboarding via Partner Referrals; Agent Toolkit for the agent's order-status tools | Core |
| **AI** — Claude (Anthropic) | Buyer agent (intake, analysis, negotiation, recommendation), seller agents (matching, offers, negotiation) | Core |
| **AG Grid** | Offer comparison grid (buyer), opportunities/bids grid (seller); live updates, grouping, master-detail, charts | Core |
| **Channel3** | Public-market product listings next to forum offers; seller catalog enrichment | Core |
| **Shopify** | Seller catalog import; order write-back after payment | High (P1) |
| **Render** | Hosting (web + worker + Postgres); eligible for Render prize | Core |

## 7. Scope by priority

Given ~3.5 days, scope is tiered. **P0 must work end-to-end before anyone starts P1.**

**P0 — the demo spine**
- Sign up / log in as buyer or seller
- Buyer chat: AI clarifies requirements → creates structured request → posts to forum
- 4–6 seeded seller agents auto-reply with structured offers
- Seller (real user) registers products via chat; their agent auto-offers on matching requests
- Buyer agent analyses offers + Channel3 listings → AG Grid offer table (live)
- Recommendation card → buyer approves → **PayPal payment routed to the winning seller** (sandbox)
- Deployed on Render with seeded data; README; demo video

**P1 — what makes it a winner**
- Saved PayPal (Vault) + spend limit → **agent pays automatically** within limit, asks above it
- Seller PayPal onboarding via Partner Referrals + **platform fee** on each order
- Shopify catalog import; create Shopify order after payment
- One negotiation round (buyer agent counters top offers; seller agents respond within guardrails)
- AG Grid: master-detail (offer thread + AI rationale), integrated chart (price vs delivery)

**P2 — only if ahead**
- Authorize-then-capture (escrow-style) with "mark delivered" to capture
- Seller reputation scores; pgvector semantic matching; SSE push instead of polling

**Out of scope:** real shipping, multi-currency, mobile app, production PayPal go-live.

## 8. Verified facts & risks

| Item | Status | Plan |
|---|---|---|
| Multiparty in sandbox without partner approval | **Verified** — PayPal docs: *"You can call and test the PayPal Complete Payments Platform APIs with your sandbox credentials before you are approved."* Approval only gates live. | Go with Multiparty. Create a **Platform REST app** in the sandbox. |
| Partner Referrals onboarding in sandbox | Documented on sandbox host (`api-m.sandbox.paypal.com/v2/customer/partner-referrals`) | P1. P0 shortcut: seed sellers with pre-created sandbox business accounts and route via `payee.merchant_id`. |
| Agent auto-pay with saved PayPal under Multiparty (platform-level vault, buyer not present, different payees) | **Not confirmed** by docs we read | Spike on Day 1. Fallback: buyer taps "Approve & Pay" → PayPal popup (one click). Demo still works. |
| Platform fee | Set in `purchase_units[].payment_instruction.platform_fees`; requires seller onboarded with fee permission | P1 with Partner Referrals. |
| Orders + Payouts fallback | Fully available in sandbox | Only if Multiparty routing fails. |
| AG Grid Enterprise license | Enterprise features show a watermark without a key | Ask the AG Grid sponsor channel for a hackathon key; watermark is acceptable otherwise. |
| Channel3 free tier | Marketing page says 1,000 free searches/month | Cache results per request; enough for dev + demo. |
| Time | 3.5 days | Feature freeze **Thu Nov 12, 12:00 GMT+8**. |

## 9. Definition of done (submission)

- [ ] Hosted demo URL on Render works with a fresh signup (and seeded demo accounts documented in README)
- [ ] Public GitHub repo, MIT license visible in About, setup instructions that work from clean clone
- [ ] Devpost text: problem, solution, features, tools used and how (Claude, PayPal APIs, AG Grid, Channel3, Shopify, Render)
- [ ] YouTube video < 3 min, public, no copyrighted music
- [ ] Every integration in the table above is visibly exercised in the video
