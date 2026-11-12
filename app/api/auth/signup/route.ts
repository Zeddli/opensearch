import { z } from "zod";
import { createSession, createUser, toPublicUser } from "@/src/lib/auth";
import { handle, json, readJson } from "@/src/lib/http";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().trim().min(1, "Name is required"),
  role: z.enum(["buyer", "seller"]),
});

export const POST = handle(async (req: Request) => {
  const body = await readJson(req, Body);
  const user = await createUser(body);
  await createSession(user.id);
  return json({ user: toPublicUser(user) }, 201);
});
