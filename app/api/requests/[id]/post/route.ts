import { z } from "zod";
import { requireUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";
import { publishRequest } from "@/src/agents/buyer/post";
import { toApiMessage } from "@/src/agents/util";

export const dynamic = "force-dynamic";

// Optional body: { windowSeconds?: number } (10–3600) — overrides OFFER_WINDOW_SECONDS (handy for tests).
const Body = z.object({ windowSeconds: z.number().int().min(10).max(3600).optional() }).default({});

export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("buyer");
  const { id } = await params;
  let body: z.infer<typeof Body> = {};
  const raw = await req.text();
  if (raw.trim()) body = Body.parse(JSON.parse(raw));
  const { request, messages } = await publishRequest(id, user.id, { windowSeconds: body.windowSeconds });
  return json({ request, messages: messages.map(toApiMessage) });
});
