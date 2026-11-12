// Email/password auth with DB-backed sessions (table auth_sessions) + httpOnly cookie.
// Server-only: uses next/headers, so call from server components / route handlers / server actions.
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { authSessions, buyerProfiles, getDb, sellerProfiles, users, type User } from "@/src/db";
import { env } from "@/src/lib/env";
import { HttpError } from "@/src/lib/http";

export const SESSION_COOKIE = "aa_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type Role = User["role"];
export type PublicUser = Pick<User, "id" | "email" | "name" | "role">;

export const toPublicUser = (u: User): PublicUser => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export const hashPassword = (password: string) => bcrypt.hash(password, 10);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** Create a user (+ buyer_profiles or seller_profiles row). Throws HttpError(409) if email taken. */
export async function createUser(p: { email: string; password: string; name: string; role: Role }): Promise<User> {
  const db = await getDb();
  const email = p.email.trim().toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) throw new HttpError(409, "An account with this email already exists");
  const passwordHash = await hashPassword(p.password);
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email, name: p.name.trim(), passwordHash, role: p.role }).returning();
    if (p.role === "buyer") await tx.insert(buyerProfiles).values({ userId: user.id });
    else await tx.insert(sellerProfiles).values({ userId: user.id, displayName: user.name });
    return user;
  });
}

/** Returns the user if email/password match, else null. */
export async function authenticate(email: string, password: string): Promise<User | null> {
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  return user;
}

/** Create a DB session and set the aa_session cookie. */
export async function createSession(userId: string): Promise<string> {
  const db = await getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(authSessions).values({ id: token, userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production" && env.APP_URL.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  });
  return token;
}

/** Delete the current DB session (if any) and clear the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(authSessions).where(eq(authSessions.id, token));
  }
  jar.delete(SESSION_COOKIE);
}

/** Resolve a session token to its user (null if missing/expired). */
export async function getUserBySessionToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const db = await getDb();
  const rows = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, token), gt(authSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
}

/** Current user from the aa_session cookie, or null. */
export async function getCurrentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getUserBySessionToken(token);
}

/** Current user or throw HttpError 401 (not signed in) / 403 (wrong role). Use inside handle(). */
export async function requireUser(role?: Role): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Not signed in");
  if (role && user.role !== role) throw new HttpError(403, `This action requires a ${role} account`);
  return user;
}
