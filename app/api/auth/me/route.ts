import { getCurrentUser, toPublicUser } from "@/src/lib/auth";
import { handle, json } from "@/src/lib/http";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await getCurrentUser();
  return json({ user: user ? toPublicUser(user) : null });
});
