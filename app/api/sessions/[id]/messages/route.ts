import { and, asc, eq, gt } from "drizzle-orm";
import { getDb, messages } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { badRequest, handle, json } from "@/src/lib/http";
import { getOwnedSession } from "@/src/agents/sessions";
import { toApiMessage } from "@/src/agents/util";

export const dynamic = "force-dynamic";

/** Poll for new messages: ?after=<ISO timestamp> (exclusive). Without `after` returns all. */
export const GET = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await getOwnedSession(user, id);
  const afterRaw = new URL(req.url).searchParams.get("after");
  let after: Date | null = null;
  if (afterRaw) {
    after = new Date(afterRaw);
    if (Number.isNaN(after.getTime())) throw badRequest("Invalid `after` timestamp");
  }
  const db = await getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(after ? and(eq(messages.sessionId, id), gt(messages.createdAt, after)) : eq(messages.sessionId, id))
    .orderBy(asc(messages.createdAt));
  return json({ messages: rows.map(toApiMessage) });
});
