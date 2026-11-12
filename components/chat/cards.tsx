"use client";

import clsx from "clsx";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Info, Pencil, Send, Sparkles, Trophy } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createProduct,
  errMsg,
  patchRequest,
  postRequest,
  qk,
  useOffers,
  type Card,
  type Offer,
  type ProductDraft,
  type RequestSpec,
} from "@/components/api";
import { ApprovePay } from "@/components/payment/approve-pay";
import { ReceiptView } from "@/components/payment/receipt";
import { Badge, Button, ErrorNote, Field, inputCls, money, pct, Spinner } from "@/components/ui";
import type { ProductConfirmCard, RecommendationCard, RequestSummaryCard, StatusCard } from "@/src/agents/protocol";

export function CardView({ card, sessionId, compact, messageId }: { card: Card; sessionId: string; compact?: boolean; messageId?: string }) {
  switch (card.type) {
    case "request_summary":
      return <RequestSummaryView card={card} sessionId={sessionId} />;
    case "product_confirm":
      return <ProductConfirmView card={card} sessionId={sessionId} messageId={messageId} />;
    case "recommendation":
      return <RecommendationView card={card} sessionId={sessionId} compact={compact} />;
    case "receipt":
      return <ReceiptView receipt={card} />;
    case "status":
      return <StatusView card={card} />;
    default:
      return null;
  }
}

function CardShell({ title, icon, right, children }: { title: string; icon: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2.5">
        <span className="text-accent">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto">{right}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ---------------- request_summary ----------------

const splitList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function RequestSummaryView({ card, sessionId }: { card: RequestSummaryCard; sessionId: string }) {
  const qc = useQueryClient();
  const [spec, setSpec] = useState<RequestSpec>(card.spec);
  const [editing, setEditing] = useState(false);
  const [posted, setPosted] = useState(card.posted);
  const [busy, setBusy] = useState<"save" | "post" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPosted = posted || card.posted;

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await patchRequest(card.requestId, spec);
      setEditing(false);
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function post() {
    setBusy("post");
    setError(null);
    try {
      if (editing) await patchRequest(card.requestId, spec);
      await postRequest(card.requestId);
      setPosted(true);
      setEditing(false);
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const s = editing ? spec : isPosted ? card.spec : spec;

  return (
    <CardShell
      title="Request summary"
      icon={<Send className="size-4" />}
      right={isPosted ? <Badge tone="ok">Posted to forum</Badge> : <Badge tone="warn">Draft</Badge>}
    >
      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Item" value={spec.item} onChange={(e) => setSpec({ ...spec, item: e.target.value })} className="sm:col-span-2" />
          <Field
            label="Quantity"
            type="number"
            min={1}
            value={spec.quantity}
            onChange={(e) => setSpec({ ...spec, quantity: Math.max(1, Number(e.target.value) || 1) })}
          />
          <Field
            label="Budget (max total, USD)"
            type="number"
            min={0}
            step="0.01"
            value={spec.budgetMaxCents / 100}
            onChange={(e) => setSpec({ ...spec, budgetMaxCents: Math.round((Number(e.target.value) || 0) * 100) })}
          />
          <Field label="Deadline" type="date" value={spec.deadline} onChange={(e) => setSpec({ ...spec, deadline: e.target.value })} />
          <Field label="Delivery location" value={spec.location} onChange={(e) => setSpec({ ...spec, location: e.target.value })} />
          <label className="block text-xs font-medium text-fg-2 sm:col-span-2">
            Must-haves <span className="font-normal text-muted">(comma separated)</span>
            <textarea
              rows={2}
              className={clsx(inputCls, "mt-1 resize-none")}
              defaultValue={spec.mustHave.join(", ")}
              onChange={(e) => setSpec({ ...spec, mustHave: splitList(e.target.value) })}
            />
          </label>
          <label className="block text-xs font-medium text-fg-2 sm:col-span-2">
            Nice-to-haves <span className="font-normal text-muted">(comma separated)</span>
            <textarea
              rows={2}
              className={clsx(inputCls, "mt-1 resize-none")}
              defaultValue={spec.niceToHave.join(", ")}
              onChange={(e) => setSpec({ ...spec, niceToHave: splitList(e.target.value) })}
            />
          </label>
        </div>
      ) : (
        <>
          <p className="text-base font-medium">{s.item}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Fact k="Quantity" v={`${s.quantity.toLocaleString()}${s.unit ? ` ${s.unit}` : ""}`} />
            <Fact k="Budget" v={`≤ ${money(s.budgetMaxCents)}`} />
            <Fact k="Deadline" v={s.deadline} />
            <Fact k="Deliver to" v={s.location} />
          </dl>
          {(s.mustHave.length > 0 || s.niceToHave.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {s.mustHave.map((m) => (
                <Badge key={`m-${m}`} tone="accent">
                  {m}
                </Badge>
              ))}
              {s.niceToHave.map((m) => (
                <Badge key={`n-${m}`}>{m} · nice</Badge>
              ))}
            </div>
          )}
        </>
      )}

      {!!error && <ErrorNote className="mt-3">{error}</ErrorNote>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isPosted ? (
          <Link href={`/s/${sessionId}?tab=forum`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            Watch offers arrive in the forum <ExternalLink className="size-3.5" />
          </Link>
        ) : (
          <>
            <Button variant="primary" onClick={post} loading={busy === "post"} disabled={busy !== null}>
              <Send className="size-3.5" /> Post to forum
            </Button>
            {editing ? (
              <>
                <Button onClick={save} loading={busy === "save"} disabled={busy !== null}>
                  Save changes
                </Button>
                <Button variant="ghost" onClick={() => (setSpec(card.spec), setEditing(false))} disabled={busy !== null}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
          </>
        )}
      </div>
    </CardShell>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className="truncate font-medium" title={v}>
        {v}
      </dd>
    </div>
  );
}

// ---------------- product_confirm ----------------

function ProductConfirmView({ card, sessionId, messageId }: { card: ProductConfirmCard; sessionId: string; messageId?: string }) {
  const qc = useQueryClient();
  const [d, setD] = useState<ProductDraft>(card.draft);
  const [savedId, setSavedId] = useState<string | undefined>(card.savedProductId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = Boolean(savedId || card.savedProductId);
  const dollars = (c: number) => c / 100;
  const cents = (v: string) => Math.round((Number(v) || 0) * 100);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await createProduct(d, messageId);
      setSavedId(r.product?.id ?? r.id ?? "saved");
      qc.invalidateQueries({ queryKey: qk.products });
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Confirm product" icon={<Sparkles className="size-4" />} right={saved ? <Badge tone="ok">Saved to catalog</Badge> : <Badge tone="warn">Not saved</Badge>}>
      <fieldset disabled={saved || busy} className="grid gap-3 sm:grid-cols-3">
        <Field label="Title" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} className="sm:col-span-2" />
        <Field label="Category" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} />
        <label className="block text-xs font-medium text-fg-2 sm:col-span-3">
          Description
          <textarea rows={2} className={clsx(inputCls, "mt-1 resize-none")} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </label>
        <Field label="Unit price ($)" type="number" step="0.01" min={0} value={dollars(d.unitPriceCents)} onChange={(e) => setD({ ...d, unitPriceCents: cents(e.target.value) })} />
        <Field
          label="Floor price ($)"
          hint="Agent never offers below this"
          type="number"
          step="0.01"
          min={0}
          value={dollars(d.floorPriceCents)}
          onChange={(e) => setD({ ...d, floorPriceCents: cents(e.target.value) })}
        />
        <Field label="Max discount %" type="number" min={0} max={100} value={d.maxDiscountPct} onChange={(e) => setD({ ...d, maxDiscountPct: Number(e.target.value) || 0 })} />
        <Field label="Stock" type="number" min={0} value={d.stock} onChange={(e) => setD({ ...d, stock: Number(e.target.value) || 0 })} />
        <Field label="MOQ" type="number" min={1} value={d.moq} onChange={(e) => setD({ ...d, moq: Math.max(1, Number(e.target.value) || 1) })} />
        <Field label="Lead time (days)" type="number" min={0} value={d.leadTimeDays} onChange={(e) => setD({ ...d, leadTimeDays: Number(e.target.value) || 0 })} />
      </fieldset>
      {Object.keys(d.attributes ?? {}).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.entries(d.attributes).map(([k, v]) => (
            <Badge key={k}>
              {k}: {String(v)}
            </Badge>
          ))}
        </div>
      )}
      {d.floorPriceCents > d.unitPriceCents && <ErrorNote className="mt-3">Floor price is above the list price.</ErrorNote>}
      {!!error && <ErrorNote className="mt-3">{error}</ErrorNote>}
      <div className="mt-4 flex items-center gap-2">
        {saved ? (
          <Link href="/seller/catalog" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            View in catalog <ExternalLink className="size-3.5" />
          </Link>
        ) : (
          <Button variant="primary" onClick={save} loading={busy}>
            Save product
          </Button>
        )}
      </div>
    </CardShell>
  );
}

// ---------------- recommendation ----------------

function RecommendationView({ card, sessionId, compact }: { card: RecommendationCard; sessionId: string; compact?: boolean }) {
  const { data, isLoading, error } = useOffers(card.requestId);
  const rec = card.recommendation;
  const offers = data?.offers ?? [];
  const byId = new Map(offers.map((o) => [o.id, o]));
  const ids = [rec.topOfferId, ...rec.alternativeOfferIds.filter((x) => x !== rec.topOfferId)].slice(0, 3);
  const wonOffer = offers.find((o) => o.status === "won");

  return (
    <CardShell
      title="Recommendation"
      icon={<Trophy className="size-4" />}
      right={
        rec.savingsVsMarketCents !== null && rec.savingsVsMarketCents > 0 ? (
          <Badge tone="ok">{money(rec.savingsVsMarketCents)} cheaper than public web</Badge>
        ) : null
      }
    >
      <p className="text-sm text-fg-2">{rec.summary}</p>
      {isLoading && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Spinner /> Loading offers…
        </div>
      )}
      {!!error && !isLoading && <p className="mt-3 text-sm text-muted">Offer details are unavailable right now.</p>}
      <div className={clsx("mt-3 grid gap-2", !compact && "lg:grid-cols-3")}>
        {ids.map((id, i) => {
          const o = byId.get(id);
          if (!o && !isLoading) return null;
          return (
            <OfferPick
              key={id}
              offer={o}
              top={i === 0}
              reason={rec.reasons[id]}
              locked={Boolean(wonOffer)}
              won={wonOffer?.id === id}
            />
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <Link href={`/s/${sessionId}?tab=offers`} className="font-medium text-accent hover:underline">
          Compare all offers
        </Link>
        <Link href={`/s/${sessionId}?tab=forum`} className="text-muted hover:text-fg">
          See negotiation thread
        </Link>
      </div>
    </CardShell>
  );
}

function OfferPick({ offer, top, reason, locked, won }: { offer?: Offer; top: boolean; reason?: string; locked: boolean; won: boolean }) {
  if (!offer) return <div className="h-40 animate-pulse rounded-lg bg-surface-2" />;
  const flags = offer.flags ?? [];
  return (
    <div className={clsx("flex flex-col rounded-lg border p-3", top ? "border-accent-line bg-accent-soft/50" : "border-line")}>
      <div className="flex items-center gap-1.5">
        {top ? <Badge tone="accent">Top pick</Badge> : <Badge>Alternative</Badge>}
        {won && <Badge tone="ok">Paid ✓</Badge>}
      </div>
      <p className="mt-2 truncate text-sm font-medium" title={offer.sellerName}>
        {offer.sellerName}
      </p>
      <p className="truncate text-xs text-muted" title={offer.productTitle}>
        {offer.productTitle}
      </p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums">{money(offer.totalCents)}</span>
        <span className="text-xs text-muted tabular-nums">
          {money(offer.unitPriceCents, { precise: true })} × {offer.quantity.toLocaleString()}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge tone={offer.meetsDeadline ? "ok" : "bad"}>
          {offer.etaDays}d {offer.meetsDeadline ? "✓" : "late"}
        </Badge>
        {offer.specMatch !== null && <Badge>{pct(offer.specMatch)} match</Badge>}
        {flags.slice(0, 2).map((f) => (
          <Badge key={f} tone="warn">
            {f}
          </Badge>
        ))}
      </div>
      {reason && <p className="mt-2 text-xs leading-5 text-fg-2">{reason}</p>}
      <div className="mt-auto pt-3">
        {!locked && (
          <ApprovePay
            offerId={offer.id}
            amountCents={offer.totalCents}
            sellerName={offer.sellerName}
            variant={top ? "primary" : "secondary"}
            size="sm"
            compactReceipt
          />
        )}
      </div>
    </div>
  );
}

// ---------------- status ----------------

function StatusView({ card }: { card: StatusCard }) {
  const tone = card.tone ?? "info";
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : Info;
  const action = statusAction(card);
  return (
    <div
      className={clsx(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "success" && "bg-ok-soft text-ok",
        tone === "warning" && "bg-warn-soft text-warn",
        tone === "info" && "bg-accent-soft text-accent",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block">{card.text}</span>
        {action && (
          <Link
            href={action.href}
            className="mt-2 inline-flex h-8 items-center gap-1 rounded-lg bg-surface px-3 text-xs font-medium text-fg shadow-sm ring-1 ring-line transition hover:ring-line-strong"
          >
            {action.label} <ArrowRight className="size-3.5" />
          </Link>
        )}
      </span>
    </div>
  );
}

/** Optional `action: {label, href}` on status cards (CONTRACTS-v2). Read defensively; only internal links are rendered. */
function statusAction(card: StatusCard): { label: string; href: string } | null {
  const a = (card as StatusCard & { action?: unknown }).action as { label?: unknown; href?: unknown } | undefined;
  if (!a || typeof a.label !== "string" || typeof a.href !== "string") return null;
  if (!a.href.startsWith("/") || a.href.startsWith("//")) return null;
  return { label: a.label, href: a.href };
}
