import { getCurrentUser } from "@/src/lib/auth";
import { integrationStatus } from "@/src/lib/env";
import { handle, json } from "@/src/lib/http";
import { hasAiKey } from "@/src/agents/llm";

export const dynamic = "force-dynamic";

/**
 * {paypal, channel3, ai}: each is 'configured' | 'missing' (`ai` is for the signed-in user, missing when
 * signed out). Payments run on PayPal sandbox only, so `paypal` doubles as the payments status.
 */
export const GET = handle(async () => {
  const user = await getCurrentUser();
  const ai = user && (await hasAiKey(user.id)) ? ("configured" as const) : ("missing" as const);
  return json({ ...integrationStatus(), ai });
});
