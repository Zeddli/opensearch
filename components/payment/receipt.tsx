"use client";

import { CheckCircle2 } from "lucide-react";
import type { ReceiptCard } from "@/components/api";
import { Badge, money } from "@/components/ui";

const MODE_LABEL: Record<string, string> = {
  vault: "Saved PayPal (auto-pay)",
  popup: "PayPal checkout",
};

export function ReceiptView({ receipt }: { receipt: ReceiptCard }) {
  const net = receipt.amountCents - receipt.platformFeeCents;
  return (
    <div className="overflow-hidden rounded-xl border border-ok/30 bg-surface">
      <div className="flex items-center gap-2 bg-ok-soft px-4 py-2.5">
        <CheckCircle2 className="size-4 text-ok" />
        <span className="text-sm font-medium text-ok">Payment sent to {receipt.sellerName}</span>
        <Badge className="ml-auto" tone="ok">
          {MODE_LABEL[receipt.mode] ?? "PayPal"}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <dt className="text-muted">Amount paid</dt>
        <dd className="text-right font-semibold tabular-nums">{money(receipt.amountCents, { precise: true })}</dd>
        <dt className="text-muted">Platform fee</dt>
        <dd className="text-right tabular-nums">{money(receipt.platformFeeCents, { precise: true })}</dd>
        <dt className="text-muted">Seller receives</dt>
        <dd className="text-right tabular-nums">{money(net, { precise: true })}</dd>
        <dt className="text-muted">PayPal order</dt>
        <dd className="truncate text-right font-mono text-xs leading-5">{receipt.paypalOrderId ?? "—"}</dd>
        <dt className="text-muted">Order ID</dt>
        <dd className="truncate text-right font-mono text-xs leading-5" title={receipt.orderId}>
          {receipt.orderId.slice(0, 8)}…
        </dd>
      </dl>
    </div>
  );
}
