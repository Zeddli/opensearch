"use client";
// AG Grid (v36) bootstrap — client only. Imported by grid components that are themselves
// loaded with next/dynamic({ ssr: false }).

import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import { colorSchemeDark, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { AllEnterpriseModule, LicenseManager } from "ag-grid-enterprise";
import { useMemo } from "react";
import { useIsDark } from "@/components/ui";

let registered = false;
export function ensureAgGrid() {
  if (registered) return;
  registered = true;
  ModuleRegistry.registerModules([AllEnterpriseModule.with(AgChartsEnterpriseModule)]);
  const key = process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY;
  if (key) LicenseManager.setLicenseKey(key);
}
ensureAgGrid();

const base = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 500,
  spacing: 7,
  wrapperBorderRadius: 12,
  borderRadius: 6,
  rowBorder: true,
  columnBorder: false,
});

const light = base.withParams({
  accentColor: "#4f46e5",
  backgroundColor: "#ffffff",
  foregroundColor: "#18181b",
  borderColor: "#e4e4ea",
  headerBackgroundColor: "#f6f6f8",
  oddRowBackgroundColor: "#ffffff",
  rowHoverColor: "#f3f3f6",
  selectedRowBackgroundColor: "#eef0ff",
  chromeBackgroundColor: "#f6f6f8",
});

const dark = base.withPart(colorSchemeDark).withParams({
  accentColor: "#818cf8",
  backgroundColor: "#141419",
  foregroundColor: "#ececf1",
  borderColor: "#2a2a33",
  headerBackgroundColor: "#1c1c23",
  rowHoverColor: "#1c1c23",
  chromeBackgroundColor: "#1c1c23",
});

export function useGridTheme() {
  const isDark = useIsDark();
  return useMemo(() => (isDark ? dark : light), [isDark]);
}

export function useChartThemeName() {
  const isDark = useIsDark();
  return isDark ? "ag-default-dark" : "ag-default";
}
