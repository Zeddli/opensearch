"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  approveOffer,
  capturePaypalOrder,
  createPaypalOrder,
  errMsg,
  isPaypalUnconfigured,
  PAYPAL_UNCONFIGURED_MSG,
  type PaidResult,
  type ReceiptCard,
} from "@/components/api";
import { Button, ErrorNote, Modal, money } from "@/components/ui";
import { ReceiptView } from "./receipt";

const PAYPAL_CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

type Phase =
  | { k: "idle" }
  | { k: "approving" }
  | { k: "popup"; paypalOrderId?: string }
  | { k: "paid"; receipt: ReceiptCard };

/** "Approve & pay" for a single offer: agent auto-pay with a saved PayPal wallet, or the PayPal checkout popup. */
export function ApprovePay({
  offerId,
  amountCents,
  sellerName,
  label = "Approve & pay",
  variant = "primary",
  size = "md",
  onPaid,
  disabled,
  compactReceipt,
}: {
  offerId: string;
  amountCents: number;
  sellerName: string;
  label?: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  onPaid?: (r: PaidResult) => void;
  disabled?: boolean;
  /** Show a one-line confirmation instead of the full receipt (narrow containers). */
  compactReceipt?: boolean;
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [error, setError] = useState<string | null>(null);

  function done(r: PaidResult) {
    setPhase({ k: "paid", receipt: r.receipt });
    qc.invalidateQueries();
    onPaid?.(r);
  }

  async function approve() {
    setError(null);
    setPhase({ k: "approving" });
    try {
      const r = await approveOffer(offerId);
      if (r.result === "paid") return done(r);
      if (r.result === "denied") {
        setError(r.reason || "Payment was blocked by your spending guardrails.");
        return setPhase({ k: "idle" });
      }
      if (!PAYPAL_CLIENT_ID) {
        setError("PayPal checkout can't load: NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set in this build.");
        return setPhase({ k: "idle" });
      }
      setPhase({ k: "popup", paypalOrderId: r.paypalOrderId });
    } catch (e) {
      setError(payError(e));
      setPhase({ k: "idle" });
    }
  }

  if (phase.k === "paid")
    return compactReceipt ? (
      <p className="flex items-center gap-1.5 rounded-lg bg-ok-soft px-2.5 py-1.5 text-xs font-medium text-ok">
        <ShieldCheck className="size-3.5" /> Paid {money(phase.receipt.amountCents, { precise: true })} — receipt in chat
      </p>
    ) : (
      <ReceiptView receipt={phase.receipt} />
    );

  return (
    <div className="space-y-2">
      <Button variant={variant} size={size} onClick={approve} loading={phase.k === "approving"} disabled={disabled}>
        {label}
      </Button>
      {error && <ErrorNote className="text-xs">{error}</ErrorNote>}

      <Modal open={phase.k === "popup"} onClose={() => setPhase({ k: "idle" })} label="Pay with PayPal">
        <div className="p-5">
          <p className="text-sm font-medium">Pay {sellerName}</p>
          <p className="mb-4 text-2xl font-semibold tabular-nums">{money(amountCents, { precise: true })}</p>
          {phase.k === "popup" && (
            <PayPalScriptProvider options={{ clientId: PAYPAL_CLIENT_ID, currency: "USD", intent: "capture" }}>
              <PayPalButtons
                style={{ layout: "vertical", shape: "pill", label: "pay" }}
                createOrder={async () => phase.paypalOrderId ?? (await createPaypalOrder(offerId))}
                onApprove={async (data) => {
                  try {
                    done(await capturePaypalOrder(data.orderID, offerId));
                  } catch (e) {
                    setError(payError(e));
                    setPhase({ k: "idle" });
                  }
                }}
                onCancel={() => setPhase({ k: "idle" })}
                onError={(e) => {
                  setError(e instanceof Error ? e.message : "PayPal could not complete the payment.");
                  setPhase({ k: "idle" });
                }}
              />
            </PayPalScriptProvider>
          )}
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck className="size-3.5" /> Money goes directly to the seller&apos;s PayPal account.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function payError(e: unknown) {
  return isPaypalUnconfigured(e) ? PAYPAL_UNCONFIGURED_MSG : errMsg(e);
}
