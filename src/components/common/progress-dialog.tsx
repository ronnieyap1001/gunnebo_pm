"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Loader2 } from "lucide-react";

/** Modal shown while a resumable job runs. Edits are blocked until it finishes. */
export function ProgressDialog({
  open,
  title,
  message,
  fraction,
}: {
  open: boolean;
  title: string;
  message: string;
  fraction?: number;
}) {
  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        {typeof fraction === "number" ? <Progress value={Math.round(Math.min(1, Math.max(0, fraction)) * 100)} /> : null}
        <p className="text-xs text-muted-foreground">Keep this tab open. If it closes, open the page again and it will continue.</p>
      </DialogContent>
    </Dialog>
  );
}
