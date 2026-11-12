"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PublicUser } from "@/components/api";

const Ctx = createContext<PublicUser | null>(null);

export function UserProvider({ user, children }: { user: PublicUser; children: ReactNode }) {
  return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}

export function useUser(): PublicUser {
  const u = useContext(Ctx);
  if (!u) throw new Error("useUser outside UserProvider");
  return u;
}
