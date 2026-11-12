"use client";

import { Download, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errMsg, qk, shopifyImport, useCreateSession, useProducts, useSellerSettings } from "@/components/api";
import { CatalogGrid } from "@/components/grids";
import { stashPrompt } from "@/components/home/home-dashboard";
import { PageHeader } from "@/components/shell/page-header";
import { useUser } from "@/components/shell/user-context";
import { Badge, Button, EmptyState, ErrorNote } from "@/components/ui";

export function CatalogPage() {
  const user = useUser();
  const router = useRouter();
  const qc = useQueryClient();
  const settings = useSellerSettings(user.role === "seller");
  const products = useProducts(user.role === "seller");
  const create = useCreateSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (user.role !== "seller") return <EmptyState title="Seller accounts only" className="h-full">The catalog is where sellers manage products and guardrails.</EmptyState>;

  async function addViaChat() {
    try {
      const s = await create.mutateAsync();
      stashPrompt(s.id, "I want to register a new product.");
      router.push(`/s/${s.id}`);
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    }
  }

  async function importNow() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await shopifyImport();
      setMsg({ ok: true, text: `Imported ${r.imported} product${r.imported === 1 ? "" : "s"} from Shopify.` });
      qc.invalidateQueries({ queryKey: qk.products });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const list = products.data ?? [];
  const counts = { chat: 0, shopify: 0 } as Record<string, number>;
  list.forEach((p) => (counts[p.source] = (counts[p.source] ?? 0) + 1));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Catalog & guardrails"
        subtitle="Your agent only offers what's here, never below the floor price."
        actions={
          <div className="flex flex-wrap gap-2">
            {settings.data?.shopifyConnected ? (
              <Button onClick={importNow} loading={busy}>
                <Download className="size-4" /> Import from Shopify
              </Button>
            ) : (
              <Link href="/settings?tab=store#shopify" className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface-2">
                Connect Shopify
              </Link>
            )}
            <Button variant="primary" onClick={addViaChat} loading={create.isPending}>
              <Plus className="size-4" /> Add via chat
            </Button>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{list.length} products</Badge>
          {counts.chat > 0 && <Badge tone="accent">{counts.chat} from chat</Badge>}
          {counts.shopify > 0 && <Badge tone="ok">{counts.shopify} from Shopify</Badge>}
        </div>
        {msg && (msg.ok ? <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{msg.text}</p> : <ErrorNote>{msg.text}</ErrorNote>)}
        <div className="min-h-0 flex-1">
          <CatalogGrid />
        </div>
      </div>
    </div>
  );
}
