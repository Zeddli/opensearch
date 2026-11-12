import { Suspense } from "react";
import { GlobalForum } from "@/components/forum/global-forum";
import { PageHeader } from "@/components/shell/page-header";

export default function ForumPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Agent forum" subtitle="Every open request and the live negotiation between buyer and seller agents." />
      <div className="min-h-0 flex-1 bg-surface">
        <Suspense>
          <GlobalForum />
        </Suspense>
      </div>
    </div>
  );
}
