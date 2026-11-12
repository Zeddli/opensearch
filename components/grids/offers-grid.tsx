"use client";

import "./ag-setup";
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IsRowMaster,
  RowClassParams,
  ChartRef,
} from "ag-grid-community";
import { AgGridReact, type CustomDetailCellRendererProps } from "ag-grid-react";
import { BarChart3, Download, Globe, MessagesSquare, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOffers, useStatus, type MarketListing, type Offer, type Recommendation } from "@/components/api";
import { ForumThread } from "@/components/forum/thread";
import { ApprovePay } from "@/components/payment/approve-pay";
import { Badge, Button, EmptyState, money, score100, Spinner } from "@/components/ui";
import { useChartThemeName, useGridTheme } from "./ag-setup";
import { DeadlineCell, FlagsCell, PriceCell, ProductCell, ScoreBarCell, SellerCell, StatusCell, usd } from "./cells";

type Row = {
  id: string;
  kind: "offer" | "listing";
  source: "Forum offer" | "Public web";
  seller: string;
  sellerRating: number | null;
  product: string;
  unitPrice: number;
  prevUnitPrice: number | null;
  qty: number;
  total: number;
  eta: number | null;
  meetsDeadline: boolean | null;
  warranty: string | null;
  specMatch: number | null;
  aiScore: number | null;
  flags: string[];
  status: string;
  url: string | null;
  rationale: string | null;
  pitch: string | null;
  returnPolicy: string | null;
  terms: string | null;
  version: number;
  reason: string | null;
  recommended: boolean;
  totalCents: number;
  requestId: string;
};

function offerRow(o: Offer, rec: Recommendation | null): Row {
  return {
    id: o.id,
    kind: "offer",
    source: "Forum offer",
    seller: o.sellerName,
    sellerRating: o.sellerRating ?? null,
    product: o.productTitle,
    unitPrice: o.unitPriceCents / 100,
    prevUnitPrice: null,
    qty: o.quantity,
    total: o.totalCents / 100,
    eta: o.etaDays,
    meetsDeadline: o.meetsDeadline,
    warranty: o.warranty,
    specMatch: score100(o.specMatch),
    aiScore: score100(o.aiScore),
    flags: o.flags ?? [],
    status: o.status,
    url: null,
    rationale: o.rationale,
    pitch: o.pitch,
    returnPolicy: o.returnPolicy,
    terms: o.terms,
    version: o.version,
    reason: rec?.reasons?.[o.id] ?? null,
    recommended: rec?.topOfferId === o.id,
    totalCents: o.totalCents,
    requestId: o.requestId,
  };
}

function listingRow(l: MarketListing, qty: number): Row {
  const unit = l.priceCents / 100;
  return {
    id: `l-${l.id}`,
    kind: "listing",
    source: "Public web",
    seller: l.merchant,
    sellerRating: null,
    product: l.title,
    unitPrice: unit,
    prevUnitPrice: null,
    qty,
    total: l.estTotalCents / 100,
    eta: null,
    meetsDeadline: null,
    warranty: null,
    specMatch: null,
    aiScore: null,
    flags: [],
    status: "listing",
    url: l.url,
    rationale: null,
    pitch: null,
    returnPolicy: null,
    terms: null,
    version: 1,
    reason: null,
    recommended: false,
    totalCents: l.estTotalCents,
    requestId: l.requestId,
  };
}

const same = (a: Row, b: Row) => JSON.stringify(a) === JSON.stringify(b);

export default function OffersGrid({ requestId, quantity, recommendation: recProp }: { requestId: string; quantity: number; recommendation: Recommendation | null }) {
  const theme = useGridTheme();
  const chartTheme = useChartThemeName();
  const { data, isLoading, error } = useOffers(requestId);
  const status = useStatus();
  const apiRef = useRef<GridApi<Row> | null>(null);
  const rowsRef = useRef<Map<string, Row>>(new Map());
  const chartBox = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartRef | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const rec = data?.recommendation ?? recProp;

  const rows = useMemo(() => {
    if (!data) return null;
    return [...data.offers.map((o) => offerRow(o, rec)), ...data.listings.map((l) => listingRow(l, quantity))];
  }, [data, rec, quantity]);

  // Diff incoming rows against what the grid holds; push a transaction so changed cells flash.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !ready || !rows) return;
    const prev = rowsRef.current;
    const next = new Map<string, Row>();
    const add: Row[] = [];
    const update: Row[] = [];
    for (const r0 of rows) {
      const old = prev.get(r0.id);
      const r = { ...r0 };
      if (old) {
        r.prevUnitPrice = r.unitPrice < old.unitPrice ? old.unitPrice : old.prevUnitPrice;
        if (!same(old, r)) update.push(r);
      } else add.push(r);
      next.set(r.id, r);
    }
    const remove = [...prev.values()].filter((r) => !next.has(r.id));
    rowsRef.current = next;
    if (add.length || update.length || remove.length) {
      api.applyTransactionAsync({ add, update, remove }, () => {
        // Make price drops obvious even when the row scrolls into view later.
        const dropped = update.filter((r) => r.prevUnitPrice !== null && r.unitPrice < r.prevUnitPrice).map((r) => api.getRowNode(r.id)).filter(Boolean);
        if (dropped.length) api.flashCells({ rowNodes: dropped as never[], columns: ["unitPrice", "total"], flashDuration: 1600, fadeDuration: 900 });
      });
    }
  }, [rows, ready]);

  const pinned = useMemo(() => {
    const top = rows?.find((r) => r.recommended);
    return top ? [{ ...top, id: `pinned-${top.id}` }] : [];
  }, [rows]);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      { field: "source", rowGroup: true, hide: true, enableRowGroup: true },
      { field: "seller", headerName: "Seller", cellRenderer: SellerCell, minWidth: 190, flex: 1.2, chartDataType: "category", filter: "agTextColumnFilter" },
      { field: "product", headerName: "Product", cellRenderer: ProductCell, minWidth: 200, flex: 1.4, tooltipField: "product", filter: "agTextColumnFilter" },
      {
        field: "unitPrice",
        headerName: "Unit price",
        valueFormatter: (p) => usd(p.value),
        cellRenderer: PriceCell,
        enableCellChangeFlash: true,
        type: "rightAligned",
        width: 130,
        chartDataType: "series",
        filter: "agNumberColumnFilter",
      },
      { field: "qty", headerName: "Qty", width: 80, type: "rightAligned", valueFormatter: (p) => (p.value ?? "").toLocaleString(), chartDataType: "excluded" },
      {
        field: "total",
        headerName: "Total",
        valueFormatter: (p) => usd(p.value, 0),
        enableCellChangeFlash: true,
        type: "rightAligned",
        width: 110,
        sort: undefined,
        chartDataType: "series",
        filter: "agNumberColumnFilter",
        cellClass: "font-medium",
      },
      {
        field: "eta",
        headerName: "ETA (days)",
        width: 110,
        type: "rightAligned",
        enableCellChangeFlash: true,
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "—" : `${p.value}d`),
        chartDataType: "series",
        filter: "agNumberColumnFilter",
      },
      { field: "meetsDeadline", headerName: "Deadline", cellRenderer: DeadlineCell, width: 105, filter: "agSetColumnFilter", chartDataType: "excluded" },
      { field: "warranty", headerName: "Warranty", width: 130, valueFormatter: (p) => p.value || "—", tooltipField: "warranty", chartDataType: "excluded" },
      { field: "specMatch", headerName: "Spec match", width: 110, type: "rightAligned", valueFormatter: (p) => (p.value === null || p.value === undefined ? "—" : `${Math.round(p.value)}%`), chartDataType: "excluded" },
      { field: "aiScore", headerName: "AI score", cellRenderer: ScoreBarCell, width: 140, sort: "desc", enableCellChangeFlash: true, chartDataType: "excluded", filter: "agNumberColumnFilter" },
      { field: "flags", headerName: "Flags", cellRenderer: FlagsCell, minWidth: 180, flex: 1, sortable: false, chartDataType: "excluded", filter: "agSetColumnFilter", filterParams: { valueFormatter: (p: { value: unknown }) => String(p.value ?? "") } },
      { field: "status", headerName: "Status", cellRenderer: StatusCell, width: 120, filter: "agSetColumnFilter", enableCellChangeFlash: true, chartDataType: "excluded" },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<Row>>(() => ({ sortable: true, resizable: true, filter: true, enableRowGroup: false, suppressHeaderMenuButton: false }), []);
  const autoGroupColumnDef = useMemo<ColDef<Row>>(
    () => ({
      headerName: "Source",
      minWidth: 170,
      pinned: "left",
      cellRendererParams: {
        suppressCount: false,
        innerRenderer: (p: { value: string; node: { rowPinned?: string; group?: boolean }; data?: Row }) => {
          if (p.node.rowPinned) return <span className="inline-flex items-center gap-1 font-medium text-accent"><Sparkles className="size-3.5" /> Recommended</span>;
          if (!p.node.group) return null;
          return (
            <span className="inline-flex items-center gap-1.5 font-medium">
              {p.value === "Public web" ? <Globe className="size-3.5 text-muted" /> : <MessagesSquare className="size-3.5 text-accent" />}
              {p.value}
            </span>
          );
        },
      },
    }),
    [],
  );

  const getRowId = useCallback((p: GetRowIdParams<Row>) => p.data.id, []);
  const isRowMaster = useCallback<IsRowMaster<Row>>((d) => d?.kind === "offer", []);
  const getRowClass = useCallback((p: RowClassParams<Row>) => (p.node.rowPinned ? "aa-recommended" : undefined), []);

  const onGridReady = useCallback((e: GridReadyEvent<Row>) => {
    apiRef.current = e.api;
    rowsRef.current = new Map();
    setReady(true);
  }, []);

  function toggleChart() {
    const api = apiRef.current;
    if (!api) return;
    if (chartOpen) {
      chartRef.current?.destroyChart();
      chartRef.current = null;
      setChartOpen(false);
      return;
    }
    setChartOpen(true);
    requestAnimationFrame(() => {
      chartRef.current?.destroyChart();
      chartRef.current =
        api.createRangeChart({
          chartType: "scatter",
          cellRange: { ...offerRowRange(api), columns: ["seller", "eta", "total"] },
          chartContainer: chartBox.current ?? undefined,
          suppressChartRanges: true,
          chartThemeOverrides: {
            common: {
              title: { enabled: true, text: "Price vs delivery time" },
              subtitle: { enabled: true, text: "x: delivery (days) · y: total ($) · lower-left is better" },
            },
            scatter: {
              axes: {
                number: { title: { enabled: false } },
              },
            },
          },
        }) ?? null;
    });
  }

  const offersCount = data?.offers.length ?? 0;
  const listingCount = data?.listings.length ?? 0;
  const channel3Missing = status.data?.channel3 === "missing";
  const empty = !isLoading && ((error && !data) || (data && offersCount === 0 && listingCount === 0));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">
          <MessagesSquare className="size-3" /> {offersCount} forum offer{offersCount === 1 ? "" : "s"}
        </Badge>
        {channel3Missing && listingCount === 0 ? (
          <Badge>
            <Globe className="size-3" /> Public-web comparison unavailable
          </Badge>
        ) : (
          <Badge>
            <Globe className="size-3" /> {listingCount} public listing{listingCount === 1 ? "" : "s"}
          </Badge>
        )}
        {rec?.savingsVsMarketCents ? <Badge tone="ok">Best pick saves {money(rec.savingsVsMarketCents)} vs public web</Badge> : null}
        <span className="ml-auto flex gap-2">
          <Button size="sm" onClick={toggleChart} disabled={!offersCount}>
            <BarChart3 className="size-3.5" /> {chartOpen ? "Hide chart" : "Price vs ETA"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => apiRef.current?.exportDataAsCsv({ fileName: "offers.csv" })} disabled={!offersCount && !listingCount}>
            <Download className="size-3.5" /> CSV
          </Button>
        </span>
      </div>

      <div className={chartOpen ? "h-72 shrink-0 overflow-hidden rounded-xl border border-line bg-surface" : "hidden"} ref={chartBox} />

      <div className="relative min-h-[320px] flex-1">
        {isLoading && (
          <div className="absolute inset-0 z-10 grid place-items-center">
            <Spinner />
          </div>
        )}
        {empty && (
          <div className="absolute inset-0 z-10 grid place-items-center rounded-xl border border-line bg-surface">
            <EmptyState icon={<Sparkles className="size-5" />} title={error ? "Offers unavailable" : "No offers yet"}>
              {error
                ? "The offers service isn't responding right now — this view updates automatically."
                : `Seller agents with a matching product reply here live. If no sellers have joined yet, offers appear as soon as one does.${
                    channel3Missing ? " Public-web comparison unavailable (Channel3 not configured)." : " Public-web listings appear here too."
                  }`}
            </EmptyState>
          </div>
        )}
        <div className="absolute inset-0">
          <AgGridReact<Row>
            theme={theme}
            chartThemes={[chartTheme]}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            autoGroupColumnDef={autoGroupColumnDef}
            groupDefaultExpanded={1}
            groupDisplayType="singleColumn"
            rowGroupPanelShow="never"
            getRowId={getRowId}
            onGridReady={onGridReady}
            pinnedTopRowData={pinned}
            getRowClass={getRowClass}
            masterDetail
            isRowMaster={isRowMaster}
            detailCellRenderer={OfferDetail}
            detailRowAutoHeight
            cellSelection
            enableCharts
            animateRows
            tooltipShowDelay={300}
            sideBar={{ toolPanels: ["columns", "filters"] }}
            statusBar={{ statusPanels: [{ statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" }] }}
            asyncTransactionWaitMillis={120}
            suppressCellFocus={false}
          />
        </div>
      </div>
    </div>
  );
}

/** Displayed-row span covering the forum-offer leaf rows (skips group, listing and detail rows). */
function offerRowRange(api: GridApi<Row>): { rowStartIndex?: number; rowEndIndex?: number } {
  let first: number | null = null;
  let last: number | null = null;
  api.forEachNodeAfterFilterAndSort((n) => {
    if (n.data?.kind === "offer" && !n.group && n.rowIndex !== null && n.displayed) {
      first = first === null ? n.rowIndex : Math.min(first, n.rowIndex);
      last = last === null ? n.rowIndex : Math.max(last, n.rowIndex);
    }
  });
  return first === null || last === null ? {} : { rowStartIndex: first, rowEndIndex: last };
}

function OfferDetail(p: CustomDetailCellRendererProps<Row>) {
  const r = p.data;
  if (!r) return null;
  const closed = ["won", "lost", "withdrawn"].includes(r.status);
  return (
    <div className="grid gap-4 bg-canvas p-4 lg:grid-cols-[minmax(0,320px)_1fr]" style={{ whiteSpace: "normal", lineHeight: 1.5 }}>
      <div className="space-y-3 text-sm">
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent">
            <Sparkles className="size-3.5" /> AI rationale
          </p>
          <p className="text-fg-2">{r.rationale || r.reason || "The buyer agent hasn't scored this offer yet."}</p>
        </div>
        {r.pitch && (
          <div className="rounded-xl border border-line bg-surface p-3">
            <p className="mb-1 text-xs font-medium text-muted">Seller pitch (untrusted)</p>
            <p className="text-fg-2">{r.pitch}</p>
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl border border-line bg-surface p-3 text-xs">
          <dt className="text-muted">Returns</dt>
          <dd>{r.returnPolicy || "—"}</dd>
          <dt className="text-muted">Terms</dt>
          <dd>{r.terms || "—"}</dd>
          <dt className="text-muted">Version</dt>
          <dd>v{r.version}</dd>
        </dl>
        {!closed && <ApprovePay offerId={r.id} amountCents={r.totalCents} sellerName={r.seller} size="sm" compactReceipt />}
      </div>
      <div className="max-h-[360px] min-w-0 overflow-y-auto rounded-xl border border-line bg-surface p-3">
        <p className="mb-2 text-xs font-medium text-muted">Negotiation thread</p>
        <ForumThread requestId={r.requestId} compact filterOfferId={r.id} />
      </div>
    </div>
  );
}
