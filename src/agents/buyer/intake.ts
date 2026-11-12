// Buyer agent — interactive chat: intake (LLM slot-filling with clarifying questions), draft edits,
// "post it", and Q&A once the request is live. All understanding of the buyer's text is done by the
// buyer's own LLM (structured output); nothing is guessed by rules and no slot is invented.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agentEvents, chatSessions, getDb, messages, requests, type ChatSession, type MessageRow, type RequestRow, type User } from "@/src/db";
import { RequestSpecSchema, type RequestSpec } from "@/src/agents/protocol";
import { llmObject } from "@/src/agents/llm";
import { addMessage, logEvent, todayIso } from "@/src/agents/util";
import { cleanReply } from "@/src/agents/clean-reply";
import { publishRequest } from "./post";
import { answerBuyerChat } from "./qa";

export type PartialSpec = Partial<RequestSpec>;
const REQUIRED_SLOTS = ["item", "quantity", "deadline", "location"] as const;

type IntakeState = { spec: PartialSpec; rounds: number; budgetFlexible?: boolean };

async function loadState(sessionId: string): Promise<IntakeState> {
  const db = await getDb();
  const [ev] = await db
    .select({ output: agentEvents.output })
    .from(agentEvents)
    .where(and(eq(agentEvents.tool, "intake_state"), sql`${agentEvents.input}->>'sessionId' = ${sessionId}`))
    .orderBy(desc(agentEvents.createdAt))
    .limit(1);
  const s = ev?.output as IntakeState | undefined;
  return s ?? { spec: {}, rounds: 0 };
}

const saveState = (sessionId: string, state: IntakeState, decision: string) =>
  logEvent({ actor: "buyer_agent", tool: "intake_state", input: { sessionId }, output: state, decision });

export async function latestRequestForSession(sessionId: string): Promise<RequestRow | null> {
  const db = await getDb();
  const [r] = await db.select().from(requests).where(eq(requests.sessionId, sessionId)).orderBy(desc(requests.createdAt)).limit(1);
  return r ?? null;
}

/** Explicit publish command on a draft (same as the "Post to forum" button). */
const POST_INTENT = /^\s*(?:yes|yep|yeah|sure|ok(?:ay)?|post(?: it)?(?: to (?:the )?forum)?|go(?: ahead)?|looks good|ship it|confirm(?:ed)?|publish(?: it)?|do it|lgtm)\b[\s!.]*$/i;

/** Handle a buyer chat message (user message already stored). Returns new assistant messages. */
export async function handleBuyerChat(session: ChatSession, user: User, text: string): Promise<MessageRow[]> {
  const req = await latestRequestForSession(session.id);
  if (req && req.status !== "draft") return answerBuyerChat(session, user, req, text);
  if (req && POST_INTENT.test(text)) {
    const { messages: out } = await publishRequest(req.id, user.id);
    return out;
  }
  return intake(session, user, text, req);
}

const LlmIntakeSchema = z.object({
  item: z.string().nullable().describe("What to buy, concise, including size/spec words (e.g. '12oz compostable paper cups')"),
  category: z
    .string()
    .nullable()
    .describe("Short lowercase category, e.g. cups, packaging, electronics, coffee, cafe-equipment, furniture, general"),
  quantity: z.number().int().nullable(),
  unit: z.string().nullable().describe("Unit of measure if relevant (pcs, kg, boxes), else null"),
  budgetMaxUsd: z.number().nullable().describe("Max TOTAL budget in USD incl. shipping; convert a per-unit budget by multiplying by quantity"),
  budgetFlexible: z.boolean().describe("true only if the buyer explicitly said there is no fixed budget"),
  deadline: z.string().nullable().describe("Delivery deadline as YYYY-MM-DD; resolve relative dates from today"),
  location: z.string().nullable().describe("Delivery city (and country if given)"),
  mustHave: z.array(z.string()).describe("Hard requirements (sizes, materials, certifications, printing, brand)"),
  niceToHave: z.array(z.string()).describe("Preferences"),
  intent: z
    .enum(["buy", "sell"])
    .describe("'sell' if the user wants to SELL / list / publish their own product instead of buying something; else 'buy'"),
  reply: z
    .string()
    .describe(
      "Plain conversational text only — never JSON, code blocks or the draft. If any required detail is still unknown: a short friendly message asking ONLY for the missing details (numbered, max 3 questions). Otherwise one short confirmation sentence.",
    ),
});

function missingSlots(s: PartialSpec, budgetFlexible: boolean): string[] {
  const miss: string[] = REQUIRED_SLOTS.filter((k) => s[k] == null || s[k] === "" || (k === "quantity" && !(Number(s[k]) > 0)));
  if (!(Number(s.budgetMaxCents) > 0) && !budgetFlexible) miss.push("budget");
  return miss;
}

async function intake(session: ChatSession, user: User, text: string, req: RequestRow | null): Promise<MessageRow[]> {
  const state = await loadState(session.id);
  const prior: PartialSpec = req ? { ...req.spec } : state.spec;
  const db = await getDb();
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.sessionId, session.id))
    .orderBy(asc(messages.createdAt))
    .limit(40);

  const o = await llmObject({
    userId: user.id,
    who: "buyer",
    label: "buyer.intake",
    system:
      `You are the buyer's purchasing agent on OpenQuote (buyer: ${user.name}). Today is ${todayIso()}. ` +
      "Turn the conversation into a structured purchase request. Required: item, quantity, total budget (or the buyer explicitly saying the budget is flexible), deadline, delivery location. " +
      "The current draft holds what is already known: keep its values unless the buyer changes them, and return the COMPLETE mustHave/niceToHave lists. " +
      "Use null for anything unknown. Never invent values the buyer did not give.",
    prompt:
      `CURRENT DRAFT: ${JSON.stringify(prior)}\n\nCONVERSATION (oldest first):\n` +
      history.map((m) => `${m.role}: ${m.content}`).join("\n"),
    schema: LlmIntakeSchema,
    maxOutputTokens: 4000,
  });

  if (o.intent === "sell" && !req) {
    return [
      await addMessage(
        session.id,
        "assistant",
        "It sounds like you want to **sell** a product. This account is a **buyer** account, so I can only help you buy. " +
          "Sign up for a separate **seller** account (choose *Sell* on the sign-up page) — your seller agent can then list the product and answer buyer requests.",
        { type: "status", text: "Selling needs a seller account.", tone: "info", action: { label: "Create seller account", href: "/signup?role=seller" } },
      ),
    ];
  }

  const next: PartialSpec = { ...prior };
  const setIf = <K extends keyof PartialSpec>(k: K, v: PartialSpec[K] | undefined) => {
    if (v != null && v !== "") next[k] = v;
  };
  setIf("item", o.item?.trim() || undefined);
  setIf("category", o.category?.trim().toLowerCase() || undefined);
  setIf("quantity", o.quantity && o.quantity > 0 ? o.quantity : undefined);
  setIf("unit", o.unit?.trim() || undefined);
  setIf("budgetMaxCents", o.budgetMaxUsd && o.budgetMaxUsd > 0 ? Math.round(o.budgetMaxUsd * 100) : undefined);
  setIf("deadline", o.deadline && /^\d{4}-\d{2}-\d{2}$/.test(o.deadline) ? o.deadline : undefined);
  setIf("location", o.location?.trim() || undefined);
  next.mustHave = o.mustHave.map((x) => x.trim()).filter(Boolean);
  next.niceToHave = o.niceToHave.map((x) => x.trim()).filter(Boolean);
  const budgetFlexible = o.budgetFlexible || Boolean(state.budgetFlexible);

  const missing = missingSlots(next, budgetFlexible);
  if (missing.length) {
    await saveState(session.id, { spec: next, rounds: state.rounds + 1, budgetFlexible }, `ask_clarifying: ${missing.join(", ")}`);
    return [await addMessage(session.id, "assistant", cleanReply(o.reply) || `I still need: ${missing.join(", ")}.`)];
  }

  const spec: RequestSpec = RequestSpecSchema.parse({
    item: next.item,
    category: next.category,
    quantity: next.quantity,
    unit: next.unit,
    budgetMaxCents: next.budgetMaxCents ?? 0,
    deadline: next.deadline,
    location: next.location,
    mustHave: next.mustHave ?? [],
    niceToHave: next.niceToHave ?? [],
  });
  const saved = await saveDraft(session, user, spec, req);
  await saveState(session.id, { spec, rounds: state.rounds, budgetFlexible }, req ? "update_request_draft" : "create_request_draft");
  await logEvent({ requestId: saved.id, actor: "buyer_agent", tool: "update_request_draft", input: { text }, output: spec, decision: "all slots filled" });
  const content =
    (req ? "Updated your request." : "Here's your request.") +
    ` Review it and hit **Post to forum** (or just say "post it") — seller agents will start replying within seconds.`;
  return [await addMessage(session.id, "assistant", content, { type: "request_summary", requestId: saved.id, spec, posted: false })];
}

export function requestTitle(spec: RequestSpec): string {
  const item = spec.item.charAt(0).toUpperCase() + spec.item.slice(1);
  return (spec.quantity > 1 ? `${spec.quantity} × ${item}` : item).slice(0, 120);
}

export async function saveDraft(session: ChatSession, user: User, spec: RequestSpec, req: RequestRow | null): Promise<RequestRow> {
  const db = await getDb();
  const values = {
    title: requestTitle(spec),
    spec,
    budgetMaxCents: spec.budgetMaxCents,
    deadline: spec.deadline,
    location: spec.location,
  };
  let row: RequestRow;
  if (req) {
    [row] = await db.update(requests).set(values).where(eq(requests.id, req.id)).returning();
  } else {
    [row] = await db.insert(requests).values({ ...values, sessionId: session.id, buyerId: user.id, status: "draft" }).returning();
  }
  await db.update(chatSessions).set({ title: row.title }).where(eq(chatSessions.id, session.id));
  return row;
}
