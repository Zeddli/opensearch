import { redirectToSettings } from "../../settings/redirect";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return redirectToSettings("wallet", searchParams);
}
