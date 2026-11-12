import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Legacy /buyer/settings and /seller/settings now live under /settings (PayPal return URLs still point there). */
export async function redirectToSettings(tab: string, searchParams: SearchParams): Promise<never> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (k === "tab" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  q.set("tab", tab);
  redirect(`/settings?${q.toString()}`);
}
