"use client";

import { createContext, useContext } from "react";
import type { ProjectApi } from "./use-project-api";
import type { ProjectStore } from "./store";
import type { ProjectView, RawProject } from "./types";

export interface ProjectContextValue {
  projectId: string;
  store: ProjectStore;
  raw: RawProject;
  view: ProjectView;
  timeZone: string;
  /** Actor name stored in History for this user ("You" in the UI). */
  displayName: string;
  api: ProjectApi;
  /** Archived projects can be looked at, not edited. */
  readOnly: boolean;
  /**
   * Opens the step side panel (optionally scrolled to a section). `focus: false` (J/K, arrow keys) keeps the keyboard
   * where it is instead of moving it into the value editor.
   */
  openStep: (id: string | null, section?: PanelSection, opts?: { focus?: boolean }) => void;
  selectedId: string | null;
  /** Pans the canvas to a node (no-op outside the flow view). */
  centerOn: (id: string) => void;
}

export type PanelSection = "notes" | "files" | "history" | null;

const Ctx = createContext<ProjectContextValue | null>(null);

export const ProjectContextProvider = Ctx.Provider;

export function useProject(): ProjectContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProject must be used inside the project page");
  return v;
}
