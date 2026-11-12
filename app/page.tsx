import { redirect } from "next/navigation";
import { getCurrentUser } from "@/src/lib/auth";

export const dynamic = "force-dynamic";

export default async function Index() {
  const user = await getCurrentUser();
  redirect(user ? "/home" : "/login");
}
