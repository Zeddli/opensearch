import { z } from "zod";
import { authenticate, createSession, toPublicUser } from "@/src/lib/auth";
import { handle, HttpError, json, readJson } from "@/src/lib/http";

const Body = z.object({ email: z.string().min(1), password: z.string().min(1) });

export const POST = handle(async (req: Request) => {
  const { email, password } = await readJson(req, Body);
  const user = await authenticate(email, password);
  if (!user) throw new HttpError(401, "Invalid email or password");
  await createSession(user.id);
  return json({ user: toPublicUser(user) });
});
