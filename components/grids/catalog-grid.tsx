"use client";

import "./ag-setup";
import clsx from "clsx";
import type { CellValueChangedEvent, ColDef, GetRowIdParams } from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { Package } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errMsg, patchProduct, qk, useProducts, type Product } from "@/components/api";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui";
import { useGridTheme } from "./ag-setup";
import { usd } from "./cells";

const SOURCE_STYLE: Record<string, string> = {
  chat: "bg-accent-soft text-accent",
  shopify: "bg-ok-soft text-ok",
};

function SourceCell(p: CustomCellRendererProps<Product>) {
  if (!p.value) return null;
  return <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", SOURCE_STYLE[p.value] ?? "bg-surface-2 text-fg-2")}>{p.value}</span>;
}

const dollarsParser = (p: { newValue: unknown; oldValue: unknown }) => {
  const n = Number(String(p.newValue ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : p.oldValue;
};
const intParser = (p: { newValue: unknown; oldValue: unknown }) => {
  const n = Number.parseInt(String(p.newValue ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : p.oldValue;
};

const EDITABLE: Array<keyof Product> = ["unitPriceCents", "stock", "floorPriceCents", "maxDiscountPct", "maxQtyPerOrder", "leadTimeDays", "moq", "active"];

export default function CatalogGrid() {
  const theme = useGridTheme();
  const qc = useQueryClient();
  const { data, isLoading, error } = useProducts();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);

  const cols = useMemo<ColDef<Product>[]>(
    (): ColDef<Product>[] => [
      { field: "title", headerName: "Product", minWidth: 220, flex: 1.6, filter: "agTextColumnFilter", tooltipField: "description", pinned: "left" },
      { field: "source", headerName: "Source", width: 105, cellRenderer: SourceCell, filter: "agSetColumnFilter" },
      { field: "category", headerName: "Category", width: 130, filter: "agSetColumnFilter" },
      {
        field: "unitPriceCents",
        headerName: "Price",
        editable: true,
        valueFormatter: (p) => usd((p.value ?? 0) / 100),
        valueParser: dollarsParser,
        type: "rightAligned",
        width: 105,
        cellClass: "aa-editable",
      },
      {
        field: "floorPriceCents",
        headerName: "Floor",
        headerTooltip: "Your agent never offers below this (server-enforced)",
        editable: true,
        valueFormatter: (p) => usd((p.value ?? 0) / 100),
        valueParser: dollarsParser,
        type: "rightAligned",
        width: 105,
        cellClassRules: { "text-bad font-medium": (p) => Boolean(p.data && p.data.floorPriceCents > p.data.unitPriceCents) },
      },
      { field: "maxDiscountPct", headerName: "Max disc. %", editable: true, valueParser: intParser, type: "rightAligned", width: 115, valueFormatter: (p) => `${p.value ?? 0}%` },
      { field: "stock", headerName: "Stock", editable: true, valueParser: intParser, type: "rightAligned", width: 95, cellClassRules: { "text-warn font-medium": (p) => (p.value ?? 0) < 50 } },
      { field: "moq", headerName: "MOQ", editable: true, valueParser: intParser, type: "rightAligned", width: 85 },
      {
        field: "maxQtyPerOrder",
        headerName: "Max qty/order",
        editable: true,
        valueParser: (p) => (String(p.newValue ?? "").trim() === "" ? null : intParser(p)),
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "—" : String(p.value)),
        type: "rightAligned",
        width: 125,
      },
      { field: "leadTimeDays", headerName: "Lead time", editable: true, valueParser: intParser, valueFormatter: (p) => `${p.value ?? 0}d`, type: "rightAligned", width: 105 },
      { field: "active", headerName: "Active", editable: true, cellDataType: "boolean", width: 90 },
    ],
    [],
  );

  const onCellValueChanged = useCallback(
    async (e: CellValueChangedEvent<Product>) => {
      const field = e.colDef.field as keyof Product | undefined;
      if (!field || !EDITABLE.includes(field) || e.newValue === e.oldValue || !e.data) return;
      setSaveError(null);
      setSaving((n) => n + 1);
      try {
        await patchProduct(e.data.id, { [field]: e.newValue } as Partial<Product>);
        e.api.flashCells({ rowNodes: [e.node], columns: [e.column.getColId()] });
        qc.invalidateQueries({ queryKey: qk.products });
      } catch (err) {
        setSaveError(`Couldn't save ${e.colDef.headerName}: ${errMsg(err)}`);
        e.node.setDataValue(e.column.getColId(), e.oldValue); // revert
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [qc],
  );

  const getRowId = useCallback((p: GetRowIdParams<Product>) => p.data.id, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-h-6 items-center gap-2 text-xs text-muted">
        {saving > 0 ? (
          <>
            <Spinner className="size-3" /> Saving…
          </>
        ) : (
          "Double-click a price, floor, discount or stock cell to edit. Changes save instantly."
        )}
      </div>
      {saveError && <ErrorNote className="text-xs">{saveError}</ErrorNote>}
      <div className="relative min-h-[320px] flex-1">
        {isLoading && (
          <div className="absolute inset-0 z-10 grid place-items-center">
            <Spinner />
          </div>
        )}
        {!isLoading && ((error && !data) || (data && !data.length)) && (
          <div className="absolute inset-0 z-10 grid place-items-center rounded-xl border border-line bg-surface">
            <EmptyState icon={<Package className="size-5" />} title={error ? "Catalog unavailable" : "No products yet"}>
              {error ? "The catalog service isn't responding right now." : "Register a product by chatting with your agent, or import from Shopify in Settings."}
            </EmptyState>
          </div>
        )}
        <div className="absolute inset-0">
          <AgGridReact<Product>
            theme={theme}
            rowData={data ?? []}
            columnDefs={cols}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            getRowId={getRowId}
            onCellValueChanged={onCellValueChanged}
            singleClickEdit={false}
            stopEditingWhenCellsLoseFocus
            undoRedoCellEditing
            cellSelection
            animateRows
            tooltipShowDelay={300}
            statusBar={{ statusPanels: [{ statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" }] }}
          />
        </div>
      </div>
    </div>
  );
}
