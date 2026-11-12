import { asc, eq } from "drizzle-orm";
import { getDb, messages } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { latestRequestForSession } from "@/src/agents/buyer/intake";
import { getOwnedSession } from "@/src/agents/sessions";
import { toApiMessage } from "@/src/agents/util";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  const session = await getOwnedSession(user, id);
  const db = await getDb();
  const rows = await db.select().from(messages).where(eq(messages.sessionId, id)).orderBy(asc(messages.createdAt));
  const request = session.kind === "buyer" ? await latestRequestForSession(id) : null;
  return json({ session, messages: rows.map(toApiMessage), request });
});
