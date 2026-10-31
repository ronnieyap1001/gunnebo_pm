import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

export default function ProjectNotFound() {
  return (
    <>
      <PageHeader title="Project not found" />
      <main>
        <EmptyState
          title="This project doesn't exist"
          action={
            <div className="flex gap-2">
              <Button asChild size="sm">
                <Link href="/projects">Open Projects</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/archive?tab=projects">Look in the Archive</Link>
              </Button>
            </div>
          }
        >
          The link may be old, or the project was removed. Archived projects can be restored from the Archive.
        </EmptyState>
      </main>
    </>
  );
}
