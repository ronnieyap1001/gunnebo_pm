"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Shown when a page fails to load, most often because Notion was busy or could not be reached.
 * In production the real message is hidden from the browser, so the wording covers the common case.
 * The last-resort link goes straight to Setup: it loads even while Notion is not answering, whereas every other page
 * (Settings included) needs Notion and would fail the same way.
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
          title="Notion may be busy"
          action={
            <Button size="sm" onClick={() => retry()}>
              Try again
            </Button>
          }
        >
          <p>This usually means Notion was busy or slow to answer for a moment. Wait a few seconds, then press Try again.</p>
          <p className="mt-2">
            Still failing after a few minutes? Open the{" "}
            <Link href="/setup" className="font-medium text-foreground underline underline-offset-4">
              Setup page
            </Link>
            . It checks the connection to Notion and says whether anything needs fixing.
          </p>
          {digest ? <span className="mt-2 block text-xs text-muted-foreground">Reference: {digest}</span> : null}
        </EmptyState>
      </main>
    </>
  );
}
