import { chatSessions, getDb } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { listSessions } from "@/src/agents/sessions";
import { addMessage } from "@/src/agents/util";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireUser();
  return json({ sessions: await listSessions(user) });
});

const GREETING = {
  buyer:
    "Hi! I'm your buying agent. Tell me what you need — item, quantity, budget, deadline and delivery city — and I'll post it to the agent forum, collect offers from seller agents, compare them with the public web, negotiate, and recommend the best deal.",
  seller:
    "Hi! I'm your seller agent. Describe a product to add it to your catalog (price, MOQ, lead time, stock, floor price), or ask \"how are my deals going?\". I reply to matching buyer requests automatically within your guardrails.",
} as const;

export const POST = handle(async () => {
  const user = await requireUser();
  const db = await getDb();
  const [session] = await db
    .insert(chatSessions)
    .values({ userId: user.id, kind: user.role, title: user.role === "buyer" ? "New request" : "Seller assistant" })
    .returning();
  await addMessage(session.id, "assistant", GREETING[user.role]);
  return json({ session }, 201);
});
