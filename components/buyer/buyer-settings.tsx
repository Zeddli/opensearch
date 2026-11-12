"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { Gauge, ShieldCheck, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import {
  errMsg,
  isPaypalUnconfigured,
  patchBuyerSettings,
  PAYPAL_UNCONFIGURED_MSG,
  qk,
  useBuyerSettings,
  useStatus,
  vaultConfirm,
  vaultSetupToken,
} from "@/components/api";
import { Note, Section } from "@/components/seller/seller-settings";
import { useUser } from "@/components/shell/user-context";
import { Badge, Button, EmptyState, ErrorNote, Field, money, Spinner } from "@/components/ui";

const PAYPAL_CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

/** Buyer wallet + spending guardrails (rendered inside /settings). */
export function BuyerWalletSettings() {
  const user = useUser();
  const qc = useQueryClient();
  const { data: s, isPending: isLoading, error } = useBuyerSettings(user.role === "buyer");
  const status = useStatus();
  const sp = useSearchParams();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.buyerSettings });

  const [limit, setLimit] = useState("");
  const [cap, setCap] = useState("");
  const [limBusy, setLimBusy] = useState(false);
  const [limMsg, setLimMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [showButtons, setShowButtons] = useState(false);

  useEffect(() => {
    if (!s) return;
    setLimit((v) => v || String(s.autoPayLimitCents / 100));
    setCap((v) => v || String(s.monthlyCapCents / 100));
  }, [s]);

  if (user.role !== "buyer") return <EmptyState title="Buyer accounts only" className="h-full" />;

  const paypalMissing = (s?.paypal ?? status.data?.paypal) === "missing";
  const returned = sp.get("paypal");

  function link() {
    setLinkMsg(null);
    if (paypalMissing) return setLinkMsg({ ok: false, t: PAYPAL_UNCONFIGURED_MSG });
    if (!PAYPAL_CLIENT_ID) return setLinkMsg({ ok: false, t: "PayPal buttons can't load: NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set in this build." });
    setShowButtons(true);
  }

  async function saveLimits(e: FormEvent) {
    e.preventDefault();
    const a = Math.round(Number(limit) * 100);
    const m = Math.round(Number(cap) * 100);
    if (!Number.isFinite(a) || !Number.isFinite(m) || a < 0 || m < 0) return setLimMsg({ ok: false, t: "Enter valid dollar amounts." });
    if (a > m) return setLimMsg({ ok: false, t: "The per-order limit can't exceed the monthly cap." });
    setLimBusy(true);
    setLimMsg(null);
    try {
      await patchBuyerSettings({ autoPayLimitCents: a, monthlyCapCents: m });
      setLimMsg({ ok: true, t: "Guardrails saved." });
      refresh();
    } catch (err) {
      setLimMsg({ ok: false, t: errMsg(err) });
    } finally {
      setLimBusy(false);
    }
  }

  const spentPct = s && s.monthlyCapCents > 0 ? Math.min(100, (s.spentThisMonthCents / s.monthlyCapCents) * 100) : 0;

  return (
    <div className="space-y-4">
          {isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!!error && <ErrorNote>Wallet settings are unavailable right now ({errMsg(error)}).</ErrorNote>}

          <Section
            icon={<Wallet className="size-4" />}
            title="PayPal wallet"
            desc="Save PayPal for future payments so approved orders under your limit pay instantly."
            right={s && <Badge tone={s.paypalLinked ? "ok" : "warn"}>{s.paypalLinked ? "Linked ✓" : "Not linked"}</Badge>}
          >
            {s?.paypalLinked ? (
              <p className="flex items-center gap-2 text-sm text-fg-2">
                <ShieldCheck className="size-4 text-ok" /> PayPal is saved{s.paypalVaultId ? <span className="font-mono text-xs text-muted">({s.paypalVaultId.slice(0, 10)}…)</span> : null}. Payments above your limit still need your approval.
              </p>
            ) : showButtons ? (
              <div className="max-w-sm">
                <PayPalScriptProvider options={{ clientId: PAYPAL_CLIENT_ID, vault: true, intent: "tokenize" }}>
                  <PayPalButtons
                    style={{ layout: "vertical", shape: "pill", label: "paypal" }}
                    createVaultSetupToken={async () => {
                      try {
                        return (await vaultSetupToken()).id;
                      } catch (e) {
                        setShowButtons(false);
                        setLinkMsg({ ok: false, t: isPaypalUnconfigured(e) ? PAYPAL_UNCONFIGURED_MSG : errMsg(e) });
                        throw e;
                      }
                    }}
                    onApprove={async (data) => {
                      try {
                        if (!data.vaultSetupToken) throw new Error("PayPal didn't return a setup token.");
                        await vaultConfirm(data.vaultSetupToken);
                        setShowButtons(false);
                        setLinkMsg({ ok: true, t: "PayPal linked." });
                        refresh();
                      } catch (e) {
                        setLinkMsg({ ok: false, t: errMsg(e) });
                      }
                    }}
                    onError={(e) => setLinkMsg({ ok: false, t: e instanceof Error ? e.message : "PayPal couldn't save your account." })}
                  />
                </PayPalScriptProvider>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="paypal" onClick={link} disabled={paypalMissing}>
                  Link PayPal
                </Button>
                <span className="text-xs text-muted">
                  {paypalMissing ? "PayPal is not configured on this server." : "You'll approve saving PayPal in a PayPal window."}
                </span>
              </div>
            )}
            {!linkMsg && returned === "linked" && !s?.paypalLinked && <Note ok>Returned from PayPal — your wallet status updates shortly.</Note>}
            {!linkMsg && returned === "cancel" && <Note ok={false}>PayPal linking was cancelled.</Note>}
            {linkMsg && <Note ok={linkMsg.ok}>{linkMsg.t}</Note>}
          </Section>

          <Section icon={<Gauge className="size-4" />} title="Spending guardrails" desc="Enforced on the server for every payment your agent makes.">
            <form onSubmit={saveLimits} className="grid gap-3 sm:grid-cols-2">
              <Field label="Auto-pay limit per order (USD)" type="number" min={0} step="1" value={limit} onChange={(e) => setLimit(e.target.value)} hint="Above this, your agent always asks first." />
              <Field label="Monthly cap (USD)" type="number" min={0} step="1" value={cap} onChange={(e) => setCap(e.target.value)} hint="Payments stop once this month's total is reached." />
              <div className="sm:col-span-2">
                <Button type="submit" variant="primary" loading={limBusy}>
                  Save guardrails
                </Button>
              </div>
            </form>
            {limMsg && <Note ok={limMsg.ok}>{limMsg.t}</Note>}
            {s && (
              <div className="mt-5 border-t border-line pt-4">
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="text-muted">Spent this month</span>
                  <span className="font-medium tabular-nums">
                    {money(s.spentThisMonthCents)} / {money(s.monthlyCapCents)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${spentPct}%` }} />
                </div>
              </div>
            )}
          </Section>
    </div>
  );
}
