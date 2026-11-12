import { eq } from "drizzle-orm";
import { z } from "zod";
import { chatSessions, getDb } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json, readJson } from "@/src/lib/http";
import { handleBuyerChat } from "@/src/agents/buyer/intake";
import { handleSellerChat } from "@/src/agents/seller/chat";
import { getOwnedSession } from "@/src/agents/sessions";
import { isAiError, postAiError } from "@/src/agents/ai-errors";
import { addMessage, toApiMessage } from "@/src/agents/util";

export const dynamic = "force-dynamic";

const Body = z.object({ sessionId: z.string().min(1), text: z.string().trim().min(1).max(4000) });

/** Non-streaming chat: returns only NEW messages (the user message + agent replies). */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const { sessionId, text } = await readJson(req, Body);
  const session = await getOwnedSession(user, sessionId);
  const userMsg = await addMessage(session.id, "user", text);
  let replies;
  try {
    replies = session.kind === "buyer" ? await handleBuyerChat(session, user, text) : await handleSellerChat(session, user, text);
  } catch (err) {
    if (isAiError(err)) {
      // No key → warning card with "Open settings"; LLM failure (after one retry) → warning card with the reason.
      replies = [await postAiError(session.id, err)];
      return json({ messages: [userMsg, ...replies].map(toApiMessage) });
    }
    // Validation/HTTP errors from tools (e.g. posting an already-posted request) become a friendly reply.
    console.error("[chat] agent error", err);
    const msg = err instanceof Error ? err.message : "Something went wrong";
    replies = [await addMessage(session.id, "assistant", `Sorry — I couldn't do that: ${msg}`)];
  }
  if (session.title === "New request" || session.title === "New session") {
    const db = await getDb();
    const [fresh] = await db.select({ title: chatSessions.title }).from(chatSessions).where(eq(chatSessions.id, session.id)).limit(1);
    if (fresh && (fresh.title === "New request" || fresh.title === "New session") && session.kind === "buyer") {
      await db.update(chatSessions).set({ title: text.slice(0, 60) }).where(eq(chatSessions.id, session.id));
    }
  }
  return json({ messages: [userMsg, ...replies].map(toApiMessage) });
});
