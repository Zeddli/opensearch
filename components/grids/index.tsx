"use client";
// AG Grid is browser-only: load every grid with ssr disabled.
import dynamic from "next/dynamic";
import { Spinner } from "@/components/ui";

const loading = () => (
  <div className="grid h-full min-h-[320px] place-items-center rounded-xl border border-line bg-surface">
    <Spinner />
  </div>
);

export const OffersGrid = dynamic(() => import("./offers-grid"), { ssr: false, loading });
export const DealsGrid = dynamic(() => import("./deals-grid"), { ssr: false, loading });
export const CatalogGrid = dynamic(() => import("./catalog-grid"), { ssr: false, loading });
