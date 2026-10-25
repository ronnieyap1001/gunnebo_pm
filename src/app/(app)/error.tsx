"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Shown when a page fails to load, most often because Notion was busy or could not be reached.
 * In production the real message is hidden from the browser, so the wording covers the common case.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String((error as { digest?: unknown }).digest ?? "") : "";

  return (
    <>
      <PageHeader title="Couldn't load this page" />
      <main>
        <EmptyState
          title="Notion didn't answer in time"
          action={
            <Button size="sm" onClick={() => retry()}>
              Try again
            </Button>
          }
        >
          This usually means Notion was busy for a moment. Wait a few seconds and try again. If it keeps happening, open
          the Setup page (Settings → Open Setup) to check the connection.
          {digest ? <span className="mt-2 block text-xs text-muted-foreground">Reference: {digest}</span> : null}
        </EmptyState>
      </main>
    </>
  );
}
