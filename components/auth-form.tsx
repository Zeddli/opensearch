"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

type Mode = "login" | "signup";

const input =
  "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const [role, setRole] = useState<"buyer" | "seller">(params.get("role") === "seller" ? "seller" : "buyer");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const body =
      mode === "signup"
        ? {
            name: form.get("name"),
            email: form.get("email"),
            password: form.get("password"),
            // Read from the form (radio inputs) so the choice is never lost, even if clicked before hydration.
            role: form.get("role") === "seller" ? "seller" : "buyer",
          }
        : { email: form.get("email"), password: form.get("password") };
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.issues?.[0]?.message ?? data.error ?? "Something went wrong");
        return;
      }
      router.push(next?.startsWith("/") && !next.startsWith("//") ? next : "/home");
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-lg font-medium">{mode === "login" ? "Sign in" : "Create your account"}</h2>

      {mode === "signup" && (
        <>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-zinc-700">I want to…</legend>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {(["buyer", "seller"] as const).map((r) => (
                <label
                  key={r}
                  className={clsx(
                    "flex cursor-pointer flex-col rounded-lg border-2 px-3 py-2 transition has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50",
                    "border-zinc-200 hover:border-zinc-300",
                  )}
                >
                  <span className="flex items-center gap-2 font-medium text-zinc-900">
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={role === r}
                      onChange={() => setRole(r)}
                      className="accent-indigo-600"
                    />
                    {r === "buyer" ? "Buy" : "Sell"}
                  </span>
                  <span className="mt-0.5 text-xs text-zinc-500">
                    {r === "buyer" ? "Post requests, get offers" : "List products, answer requests"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium text-zinc-700">
            {role === "seller" ? "Business name" : "Name"}
            <input name="name" required className={input} autoComplete="name" />
          </label>
        </>
      )}

      <label className="block text-sm font-medium text-zinc-700">
        Email
        <input name="email" type="email" required className={input} autoComplete="email" />
      </label>
      <label className="block text-sm font-medium text-zinc-700">
        Password
        <input
          name="password"
          type="password"
          required
          minLength={mode === "signup" ? 6 : undefined}
          className={input}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </label>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
      >
        {pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </button>

      <p className="text-center text-sm text-zinc-500">
        {mode === "login" ? "New here? " : "Already have an account? "}
        <Link href={mode === "login" ? "/signup" : "/login"} className="font-medium text-indigo-600 hover:underline">
          {mode === "login" ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </form>
  );
}
