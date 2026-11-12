"use client";

import { CheckCircle2, CreditCard, Download, ExternalLink, Plug, Store, Zap } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  errMsg,
  isPaypalUnconfigured,
  patchSellerSettings,
  PAYPAL_UNCONFIGURED_MSG,
  paypalOnboard,
  qk,
  shopifyConnect,
  shopifyDisconnect,
  shopifyImport,
  useSellerSettings,
  useStatus,
} from "@/components/api";
import { useUser } from "@/components/shell/user-context";
import { Badge, Button, EmptyState, ErrorNote, Field, Panel, Spinner, Toggle } from "@/components/ui";

export function Section({ icon, title, desc, right, children, id }: { icon: ReactNode; title: string; desc?: string; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <Panel className="scroll-mt-4 p-5" >
      <div id={id} className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {desc && <p className="mt-0.5 text-xs text-muted">{desc}</p>}
        </div>
        {right}
      </div>
      {children}
    </Panel>
  );
}

const ONBOARD_ERRORS: Record<string, string> = {
  paypal_not_configured: "PayPal is not configured on this server, so seller onboarding is unavailable.",
  missing_merchant_id: "PayPal didn't return a merchant ID. Finish onboarding in PayPal, or paste your merchant ID below.",
  tracking_mismatch: "That PayPal onboarding link belonged to a different account. Start again from here.",
  unknown_seller: "We couldn't match the PayPal onboarding to your account. Start again from here.",
  not_signed_in: "Sign in as the seller who started onboarding, then try again.",
  paypal_error: "PayPal returned an error while finishing onboarding. Please try again.",
};

export function Note({ ok, children }: { ok: boolean; children: ReactNode }) {
  return ok ? <p className="mt-3 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{children}</p> : <ErrorNote className="mt-3">{children}</ErrorNote>;
}

/** Seller payouts, Shopify, auto-deal and storefront profile (rendered inside /settings). */
export function SellerStoreSettings() {
  const user = useUser();
  const qc = useQueryClient();
  const sp = useSearchParams();
  const { data: s, isPending: isLoading, error } = useSellerSettings(user.role === "seller");
  const status = useStatus();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.sellerSettings });

  // Profile
  const [displayName, setDisplayName] = useState("");
  const [tagline, setTagline] = useState("");
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  // PayPal
  const [merchantId, setMerchantId] = useState("");
  const [ppBusy, setPpBusy] = useState<"onboard" | "save" | null>(null);
  const [ppMsg, setPpMsg] = useState<{ ok: boolean; t: string } | null>(null);
  // Shopify
  const [domain, setDomain] = useState("");
  const [token, setToken] = useState("");
  const [shBusy, setShBusy] = useState<"connect" | "import" | "disconnect" | null>(null);
  const [shMsg, setShMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);

  useEffect(() => {
    if (!s) return;
    setDisplayName((v) => v || s.displayName);
    setTagline((v) => v || s.tagline);
    setMerchantId((v) => v || s.paypalMerchantId || "");
    setDomain((v) => v || s.shopifyDomain || "");
  }, [s]);

  useEffect(() => {
    if (location.hash === "#shopify") document.getElementById("shopify")?.scrollIntoView({ behavior: "smooth" });
  }, [isLoading]);

  if (user.role !== "seller") return <EmptyState title="Seller accounts only" className="h-full" />;

  const paypalMissing = (s?.paypal ?? status.data?.paypal) === "missing";
  const paypalOk = s?.payoutReady;
  const returned = sp.get("onboarded") ?? sp.get("onboarding") ?? sp.get("paypal");
  const returnError = sp.get("error");

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      await patchSellerSettings({ displayName, tagline });
      setProfileMsg({ ok: true, t: "Saved." });
      refresh();
    } catch (err) {
      setProfileMsg({ ok: false, t: errMsg(err) });
    } finally {
      setProfileBusy(false);
    }
  }

  async function onboard() {
    setPpBusy("onboard");
    setPpMsg(null);
    try {
      const r = await paypalOnboard();
      if (r.actionUrl) window.location.href = r.actionUrl;
      else setPpMsg({ ok: false, t: "PayPal didn't return a signup link." });
    } catch (err) {
      setPpMsg({ ok: false, t: isPaypalUnconfigured(err) ? PAYPAL_UNCONFIGURED_MSG : errMsg(err) });
    } finally {
      setPpBusy(null);
    }
  }

  async function saveMerchant(e: FormEvent) {
    e.preventDefault();
    setPpBusy("save");
    setPpMsg(null);
    try {
      await patchSellerSettings({ paypalMerchantId: merchantId.trim() });
      setPpMsg({ ok: true, t: merchantId.trim() ? "Merchant ID saved — you can receive payments." : "Merchant ID cleared." });
      refresh();
    } catch (err) {
      setPpMsg({ ok: false, t: errMsg(err) });
    } finally {
      setPpBusy(null);
    }
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    setShBusy("connect");
    setShMsg(null);
    try {
      const r = await shopifyConnect(domain.trim(), token.trim());
      setShMsg({ ok: true, t: `Connected to ${r.shopName ?? r.domain ?? domain}. Now import your products.` });
      setToken("");
      refresh();
    } catch (err) {
      setShMsg({ ok: false, t: errMsg(err) });
    } finally {
      setShBusy(null);
    }
  }

  async function doImport() {
    setShBusy("import");
    setShMsg(null);
    try {
      const r = await shopifyImport();
      setShMsg({ ok: true, t: `Imported ${r.imported} product${r.imported === 1 ? "" : "s"}. Review guardrails in the catalog.` });
      qc.invalidateQueries({ queryKey: qk.products });
      refresh();
    } catch (err) {
      setShMsg({ ok: false, t: errMsg(err) });
    } finally {
      setShBusy(null);
    }
  }

  async function disconnect() {
    setShBusy("disconnect");
    setShMsg(null);
    try {
      await shopifyDisconnect();
      setShMsg({ ok: true, t: "Disconnected. Imported products were kept." });
      refresh();
    } catch (err) {
      setShMsg({ ok: false, t: errMsg(err) });
    } finally {
      setShBusy(null);
    }
  }

  async function setAutoDeal(v: boolean) {
    setAutoBusy(true);
    try {
      await patchSellerSettings({ autoDeal: v });
      refresh();
    } catch {
      /* surfaced by stale state */
    } finally {
      setAutoBusy(false);
    }
  }

  return (
    <div className="space-y-4">
          {isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!!error && <ErrorNote>Settings are unavailable right now ({errMsg(error)}).</ErrorNote>}

          <Section icon={<CreditCard className="size-4" />} title="PayPal payouts" desc="Buyers pay you directly; the platform fee is taken at capture." right={s && <Badge tone={paypalOk ? "ok" : s.onboardingStatus === "pending" ? "warn" : "bad"}>{paypalOk ? "Payments receivable ✓" : s.onboardingStatus === "pending" ? "Pending" : "Not connected"}</Badge>}>
            {returned && !returnError && <Note ok>Returned from PayPal — your onboarding status updates automatically.</Note>}
            {returnError && <Note ok={false}>{ONBOARD_ERRORS[returnError] ?? "PayPal onboarding didn't complete. Please try again."}</Note>}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="paypal" onClick={onboard} loading={ppBusy === "onboard"} disabled={paypalMissing}>
                {paypalOk ? "Reconnect PayPal" : "Connect with PayPal"} <ExternalLink className="size-3.5" />
              </Button>
              <span className="text-xs text-muted">
                {paypalMissing ? "PayPal is not configured on this server." : "Opens PayPal's seller onboarding."}
              </span>
            </div>
            <form onSubmit={saveMerchant} className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
              <Field label="Or paste your PayPal merchant ID" placeholder="e.g. 7XK2ABCDEF3GH" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} className="flex-1" />
              <Button type="submit" loading={ppBusy === "save"}>
                Save
              </Button>
            </form>
            {ppMsg && <Note ok={ppMsg.ok}>{ppMsg.t}</Note>}
          </Section>

          <div id="shopify" className="scroll-mt-4" />
          <Section
            icon={<Plug className="size-4" />}
            title="Shopify"
            desc="Import your catalog and have paid orders created in your store automatically."
            right={s && <Badge tone={s.shopifyConnected ? "ok" : "neutral"}>{s.shopifyConnected ? "Connected" : "Not connected"}</Badge>}
          >
            {s?.shopifyConnected ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1.5 text-sm">
                  <CheckCircle2 className="size-4 text-ok" /> {s.shopifyDomain}
                </span>
                {s.productCounts && <Badge>{s.productCounts.shopify} imported</Badge>}
                <span className="ml-auto flex gap-2">
                  <Button variant="primary" onClick={doImport} loading={shBusy === "import"}>
                    <Download className="size-4" /> Import products
                  </Button>
                  <Button variant="ghost" onClick={disconnect} loading={shBusy === "disconnect"}>
                    Disconnect
                  </Button>
                </span>
              </div>
            ) : (
              <form onSubmit={connect} className="grid gap-3 sm:grid-cols-2">
                <Field label="Store domain" placeholder="your-store.myshopify.com" value={domain} onChange={(e) => setDomain(e.target.value)} required />
                <Field label="Admin API token" placeholder="shpat_… or clientId:clientSecret" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
                <div className="sm:col-span-2">
                  <Button type="submit" variant="primary" loading={shBusy === "connect"}>
                    Connect store
                  </Button>
                </div>
              </form>
            )}
            {shMsg && <Note ok={shMsg.ok}>{shMsg.t}</Note>}
          </Section>

          <Section icon={<Zap className="size-4" />} title="Auto-deal" desc="Let your agent offer and negotiate automatically within each product's floor price and max discount." right={<Toggle label="Auto-deal" checked={s?.autoDeal ?? true} onChange={setAutoDeal} disabled={!s || autoBusy} />}>
            <p className="text-xs text-muted">When off, your agent still sees matching requests but won&apos;t post offers. Floors are always enforced on the server.</p>
          </Section>

          <Section icon={<Store className="size-4" />} title="Storefront profile" desc="How your agent introduces itself on the forum.">
            <form onSubmit={saveProfile} className="grid gap-3">
              <Field label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <Field label="Tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Eco packaging, printed in 5 days" />
              <div>
                <Button type="submit" loading={profileBusy}>
                  Save profile
                </Button>
              </div>
            </form>
            {profileMsg && <Note ok={profileMsg.ok}>{profileMsg.t}</Note>}
          </Section>
    </div>
  );
}
