// How agents surface AI problems to users: a missing key (warning card with an "Open settings"
// action) or a failed LLM call (warning card with the error). No fallback output is invented.
import { and, desc, eq, gt } from "drizzle-orm";
import { agentEvents, getDb, type MessageRow } from "@/src/db";
import { LlmError, MissingAiKeyError, MISSING_KEY_TEXT, describeLlmError } from "@/src/agents/llm";
import { addStatus, logEvent, notifySeller, SETTINGS_ACTION } from "@/src/agents/util";

export function isAiError(err: unknown): err is MissingAiKeyError | LlmError {
  return err instanceof MissingAiKeyError || err instanceof LlmError;
}

/** Text for a status card describing an AI failure. */
export function aiErrorText(err: unknown, doing?: string): string {
  if (err instanceof MissingAiKeyError) return MISSING_KEY_TEXT;
  const why = err instanceof LlmError ? err.message : describeLlmError(err);
  return doing ? `I couldn't ${doing}: ${why}` : why;
}

/** Post the AI-error status card in a chat session (buyer or seller). */
export function postAiError(sessionId: string, err: unknown, doing?: string): Promise<MessageRow> {
  const needsSettings = err instanceof MissingAiKeyError || (err instanceof LlmError && (err.status === 401 || err.status === 403 || err.status === 404));
  return addStatus(sessionId, aiErrorText(err, doing), "warning", needsSettings ? SETTINGS_ACTION : undefined);
}

const SELLER_WARN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A seller agent couldn't run because of an AI problem. Logs it and warns the seller in their chat,
 * at most once per hour per seller (no spam across many requests).
 */
export async function warnSellerAi(sellerId: string, err: unknown, requestId: string | null, doing: string): Promise<void> {
  const actor = `seller_agent:${sellerId}`;
  const tool = err instanceof MissingAiKeyError ? "missing_ai_key" : "llm_error";
  await logEvent({ requestId, actor, tool: `${tool}_skip`, input: { doing }, output: { error: aiErrorText(err) }, decision: "skip" });
  const db = await getDb();
  const since = new Date(Date.now() - SELLER_WARN_INTERVAL_MS);
  const [recent] = await db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(and(eq(agentEvents.actor, actor), eq(agentEvents.tool, `${tool}_warned`), gt(agentEvents.createdAt, since)))
    .orderBy(desc(agentEvents.createdAt))
    .limit(1);
  if (recent) return;
  await logEvent({ requestId, actor, tool: `${tool}_warned`, decision: "warned" });
  const text =
    err instanceof MissingAiKeyError
      ? `Your agent skipped a buyer request because no AI key is set. ${MISSING_KEY_TEXT}`
      : `Your agent couldn't ${doing}: ${aiErrorText(err)}`;
  const needsSettings = err instanceof MissingAiKeyError || (err instanceof LlmError && (err.status === 401 || err.status === 403 || err.status === 404));
  await notifySeller(sellerId, text, "warning", needsSettings ? SETTINGS_ACTION : undefined);
}
