import { destroySession } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";

export const POST = handle(async () => {
  await destroySession();
  return json({ ok: true });
});
