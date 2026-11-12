"use client";

import "./ag-setup";
import clsx from "clsx";
import type { ColDef, GetRowIdParams } from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { Handshake } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useDeals, type Deal } from "@/components/api";
import { safeAgo } from "@/components/shell/app-shell";
import { EmptyState, Spinner } from "@/components/ui";
import { useGridTheme } from "./ag-setup";
import { usd } from "./cells";

const STAGES = ["offered", "negotiating", "won", "paid"] as const;
function stageOf(status: string): { idx: number; lost: boolean; label: string } {
  const s = status.toLowerCase();
  if (s === "lost" || s === "withdrawn") return { idx: 1, lost: true, label: s === "lost" ? "Not selected" : "Withdrawn" };
  if (s === "paid") return { idx: 3, lost: false, label: "Paid" };
  if (s === "won") return { idx: 2, lost: false, label: "Won" };
  if (s === "countered" || s === "revised" || s === "negotiating") return { idx: 1, lost: false, label: s === "countered" ? "Countered" : "Revised" };
  return { idx: 0, lost: false, label: "Offered" };
}

function PipelineCell(p: CustomCellRendererProps<Deal>) {
  if (!p.data) return null;
  const st = stageOf(p.data.status);
  return (
    <span className="flex h-full items-center gap-2">
      <span className="flex items-center gap-0.5">
        {STAGES.map((s, i) => (
          <span
            key={s}
            title={s}
            className={clsx(
              "h-1.5 w-5 rounded-full",
              st.lost && i <= st.idx ? "bg-bad/60" : i <= st.idx ? (st.idx === 3 ? "bg-ok" : "bg-accent") : "bg-surface-2",
            )}
          />
        ))}
      </span>
      <span className={clsx("text-xs font-medium", st.lost ? "text-bad" : st.idx >= 2 ? "text-ok" : "text-fg-2")}>{st.label}</span>
    </span>
  );
}

function BudgetCell(p: CustomCellRendererProps<Deal>) {
  if (!p.data) return null;
  const { totalCents, budgetMaxCents } = p.data;
  const ratio = budgetMaxCents > 0 ? totalCents / budgetMaxCents : 0;
  const over = ratio > 1;
  return (
    <span className="flex h-full items-center gap-2" title={`${usd(totalCents / 100, 0)} of ${usd(budgetMaxCents / 100, 0)} budget`}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: over ? "var(--color-bad)" : "var(--color-accent)" }} />
      </span>
      <span className={clsx("w-10 text-right text-xs tabular-nums", over ? "text-bad" : "text-fg-2")}>{Math.round(ratio * 100)}%</span>
    </span>
  );
}

export default function DealsGrid({ requestId }: { requestId?: string }) {
  const theme = useGridTheme();
  const { data, isLoading, error } = useDeals();
  const rows = useMemo(() => (data ?? []).filter((d) => !requestId || d.requestId === requestId), [data, requestId]);

  const cols = useMemo<ColDef<Deal>[]>(
    () => [
      {
        field: "requestTitle",
        headerName: "Request",
        minWidth: 220,
        flex: 1.5,
        cellRenderer: (p: CustomCellRendererProps<Deal>) =>
          p.data ? (
            <Link href={`/forum?r=${p.data.requestId}`} className="hover:text-accent hover:underline">
              {p.value}
            </Link>
          ) : null,
        filter: "agTextColumnFilter",
      },
      { field: "buyerName", headerName: "Buyer agent", minWidth: 150, flex: 1, filter: "agSetColumnFilter" },
      {
        field: "status",
        headerName: "Pipeline",
        cellRenderer: PipelineCell,
        width: 210,
        filter: "agSetColumnFilter",
        enableCellChangeFlash: true,
        comparator: (a: string, b: string) => stageOf(a).idx - stageOf(b).idx,
      },
      { field: "unitPriceCents", headerName: "My unit price", valueFormatter: (p) => usd((p.value ?? 0) / 100), type: "rightAligned", width: 130, enableCellChangeFlash: true, filter: "agNumberColumnFilter" },
      { field: "quantity", headerName: "Qty", width: 90, type: "rightAligned" },
      { field: "totalCents", headerName: "My total", valueFormatter: (p) => usd((p.value ?? 0) / 100, 0), type: "rightAligned", width: 120, enableCellChangeFlash: true, cellClass: "font-medium", aggFunc: "sum" },
      { colId: "budget", headerName: "vs buyer budget", cellRenderer: BudgetCell, width: 170, sortable: true, valueGetter: (p) => (p.data && p.data.budgetMaxCents ? p.data.totalCents / p.data.budgetMaxCents : null) },
      { field: "competingOffers", headerName: "Competing", width: 110, type: "rightAligned", headerTooltip: "Other offers on this request (prices hidden)" },
      { field: "updatedAt", headerName: "Updated", width: 130, valueFormatter: (p) => safeAgo(p.value), sort: "desc" },
    ],
    [],
  );

  const getRowId = (p: GetRowIdParams<Deal>) => p.data.offerId;

  return (
    <div className="relative h-full min-h-[320px]">
      {isLoading && (
        <div className="absolute inset-0 z-10 grid place-items-center">
          <Spinner />
        </div>
      )}
      {!isLoading && ((error && !data) || (data && rows.length === 0)) && (
        <div className="absolute inset-0 z-10 grid place-items-center rounded-xl border border-line bg-surface">
          <EmptyState icon={<Handshake className="size-5" />} title={error ? "Deals unavailable" : "No deals yet"}>
            {error ? "The deals service isn't responding right now." : "When your agent makes an offer on a buyer request, it shows up here and moves through the pipeline live."}
          </EmptyState>
        </div>
      )}
      <div className="absolute inset-0">
        <AgGridReact<Deal>
          theme={theme}
          rowData={rows}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={getRowId}
          animateRows
          cellSelection
          sideBar={{ toolPanels: ["filters", "columns"] }}
          statusBar={{
            statusPanels: [
              { statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" },
              { statusPanel: "agAggregationComponent", align: "right" },
            ],
          }}
        />
      </div>
    </div>
  );
}
