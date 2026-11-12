import { Suspense } from "react";
import { SessionView } from "@/components/session/session-view";

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return (
    <Suspense>
      <SessionView key={sessionId} sessionId={sessionId} />
    </Suspense>
  );
}
