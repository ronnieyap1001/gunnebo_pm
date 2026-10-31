"use client";

import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, Link2, Loader2, Paperclip, Plus, Trash2, Upload } from "lucide-react";
import { isHttpUrl } from "@/domain/values";
import type { AttachmentDTO } from "@/server/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProject } from "./context";
import { formatBytes } from "./format";

function isSharePoint(url: string | null): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith("sharepoint.com") || h.endsWith("onedrive.live.com") || h === "1drv.ms";
  } catch {
    return false;
  }
}

/** Links (SharePoint / OneDrive or any http(s) address) and files up to 4 MB, with a drop zone. */
export function StepFiles({ stepId }: { stepId: string }) {
  const { raw, api, readOnly } = useProject();
  const items = raw.attachments.filter((a) => a.stepId === stepId && !a.archived);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const urlValid = isHttpUrl(url.trim());

  async function addLink() {
    if (!urlValid || adding) return;
    setAdding(true);
    const ok = await api.addLink(stepId, url.trim(), name.trim() || undefined);
    setAdding(false);
    if (ok) {
      setUrl("");
      setName("");
      setLinkOpen(false);
    }
  }

  function uploadAll(files: FileList | File[]) {
    for (const f of Array.from(files)) void api.uploadFile(stepId, f);
  }

  return (
    <div
      className={cn("space-y-2 rounded-md", dragging && "outline-2 outline-dashed outline-offset-4 outline-ring")}
      onDragOver={(e) => {
        if (readOnly || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) uploadAll(e.dataTransfer.files);
      }}
    >
      {!readOnly ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setLinkOpen((o) => !o)} aria-expanded={linkOpen}>
            <Link2 aria-hidden /> Link
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
            <Plus aria-hidden /> File
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose files to upload"
            onChange={(e) => {
              if (e.target.files?.length) uploadAll(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : null}

      {linkOpen && !readOnly ? (
        <form
          className="space-y-1.5 rounded-md border bg-muted/30 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addLink();
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://gunnebo.sharepoint.com/…"
            aria-label="Link address"
            aria-invalid={(url.trim() !== "" && !urlValid) || undefined}
            autoFocus
            className="h-8"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setLinkOpen(false);
              }
            }}
          />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Link name" className="h-8" />
          {url.trim() && !urlValid ? <p className="text-xs text-destructive">Links must start with http:// or https://</p> : null}
          <div className="flex justify-end gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!urlValid || adding}>
              {adding ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add link
            </Button>
          </div>
        </form>
      ) : null}

      {items.length ? (
        <ul className="divide-y rounded-md border">
          {items.map((a) => (
            <AttachmentRow key={a.id} a={a} readOnly={readOnly} />
          ))}
        </ul>
      ) : null}

      {!readOnly ? (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className={cn(
            "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50",
            dragging && "border-ring bg-muted/60 text-foreground",
          )}
        >
          <Upload className="size-4" aria-hidden />
          <span>Drop files here or click to choose (up to 4 MB each)</span>
          <span className="text-[11px]">Bigger files: add a SharePoint or OneDrive link</span>
        </button>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No files or links.</p>
      ) : null}
    </div>
  );
}

function AttachmentRow({ a, readOnly }: { a: AttachmentDTO; readOnly: boolean }) {
  const { api } = useProject();
  const pending = a.id.startsWith("tmp-");
  const href = a.kind === "LINK" ? (a.url ?? "#") : `/api/files/${a.id}`;
  const Icon = a.kind === "LINK" ? (isSharePoint(a.url) ? Paperclip : Link2) : FileText;
  return (
    <li className="group flex h-9 items-center gap-2 px-2 text-sm">
      {pending ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Uploading" /> : <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      {pending ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.name}</span>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:underline" title={a.kind === "LINK" ? (a.url ?? a.name) : a.name}>
          {a.name}
        </a>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {pending ? (a.kind === "FILE" ? "Uploading…" : "Saving…") : a.kind === "FILE" ? formatBytes(a.size) : isSharePoint(a.url) ? "SharePoint" : "Link"}
      </span>
      {!pending ? (
        <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {a.kind === "FILE" ? (
            <Button asChild size="icon-xs" variant="ghost">
              <a href={`/api/files/${a.id}?download=1`} aria-label={`Download ${a.name}`}>
                <Download aria-hidden />
              </a>
            </Button>
          ) : (
            <Button asChild size="icon-xs" variant="ghost">
              <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.name}`}>
                <ExternalLink aria-hidden />
              </a>
            </Button>
          )}
          {!readOnly ? (
            <Button size="icon-xs" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => void api.archiveAttachment(a)}>
              <Trash2 aria-hidden />
            </Button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}
