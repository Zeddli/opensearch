"use client";

import clsx from "clsx";
import { KeyRound, Store, Wallet } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BuyerWalletSettings } from "@/components/buyer/buyer-settings";
import { SellerStoreSettings } from "@/components/seller/seller-settings";
import { PageHeader } from "@/components/shell/page-header";
import { useUser } from "@/components/shell/user-context";
import { Spinner } from "@/components/ui";
import { AiProviderSettings } from "./ai-settings";

type Tab = { id: string; label: string; icon: typeof KeyRound };

export function SettingsPage() {
  const user = useUser();
  const sp = useSearchParams();
  const roleTab: Tab =
    user.role === "buyer" ? { id: "wallet", label: "Wallet & limits", icon: Wallet } : { id: "store", label: "Payouts & store", icon: Store };
  const tabs: Tab[] = [{ id: "ai", label: "AI provider", icon: KeyRound }, roleTab];
  const requested = sp.get("tab");
  const active = tabs.some((t) => t.id === requested) ? requested! : "ai";

  // Keep the rest of the query (e.g. PayPal return flags) when switching tabs.
  const hrefFor = (id: string) => {
    const q = new URLSearchParams(sp.toString());
    q.set("tab", id);
    return `/settings?${q.toString()}`;
  };

  // Settings content reads React Query data the shell may already have cached by the time this
  // Suspense boundary hydrates; render it client-only so SSR and hydration markup always match.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
  }, [active, mounted]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Settings"
        subtitle={
          user.role === "buyer"
            ? "Your AI key, PayPal wallet and spending guardrails."
            : "Your AI key, payouts, Shopify and agent behaviour."
        }
      />
      <div className="shrink-0 border-b border-line bg-surface px-4 sm:px-6">
        <nav className="-mb-px flex gap-4 overflow-x-auto" aria-label="Settings sections">
          {tabs.map(({ id, label, icon: Icon }) => (
            <Link
              key={id}
              href={hrefFor(id)}
              replace
              scroll={false}
              aria-current={active === id ? "page" : undefined}
              className={clsx(
                "flex shrink-0 items-center gap-1.5 border-b-2 py-2.5 text-sm transition",
                active === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
              )}
            >
              <Icon className="size-4" /> {label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="aa-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
          {!mounted ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <>
              {active === "ai" && <AiProviderSettings />}
              {active === "wallet" && <BuyerWalletSettings />}
              {active === "store" && <SellerStoreSettings />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
