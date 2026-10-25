import "server-only";
import { getNotion, storageMode } from "@/server/notion/client";
import {
  createRegistryHandle,
  createStorageAdmin,
  discoverRegistry,
  type Registry,
  type RegistryHandle,
} from "@/server/notion/registry";
import { createNotionRepo } from "./notionRepo";
import type { Repo, StorageAdmin } from "./types";

export type * from "./types";

/**
 * Process-wide Repo and StorageAdmin on top of getNotion() (real Notion, or the fake off Vercel without a token).
 * Both are created lazily on first use, so importing this module never touches Notion or env vars.
 *
 * Registry caching: by default each instance memoises discovery (1 h). The app can plug in a shared cache:
 *
 *   setRegistryLoader(unstable_cache(() => discoverRegistry(getNotion()), ['schema', String(SCHEMA_VERSION)],
 *     { tags: ['schema'], revalidate: 3600 }));
 *
 * and call revalidateTag('schema') / updateTag('schema') after Setup steps and on "Reload from Notion".
 */

type Holder = { repo?: Repo; admin?: StorageAdmin; handle?: RegistryHandle; loader?: () => Promise<Registry> };
const KEY = Symbol.for("gunnebo-pm.repo");
const holder = ((globalThis as { [KEY]?: Holder })[KEY] ??= {});

function registryHandle(): RegistryHandle {
  holder.handle ??= createRegistryHandle(getNotion(), { loader: holder.loader });
  return holder.handle;
}

export function getRepo(): Repo {
  holder.repo ??= createNotionRepo(getNotion(), {
    load: () => registryHandle().load(),
    require: () => registryHandle().require(),
    reset: () => registryHandle().reset(),
  });
  return holder.repo;
}

export function getStorageAdmin(): StorageAdmin {
  holder.admin ??= createStorageAdmin(() => getNotion(), () => registryHandle());
  return holder.admin;
}

/** Plug in a shared registry cache (e.g. unstable_cache around discoverRegistry). Call once at startup. */
export function setRegistryLoader(loader: (() => Promise<Registry>) | undefined): void {
  holder.loader = loader;
  holder.handle = undefined;
}

/** Tests: forget the singletons (call setNotionForTesting first when swapping the client). */
export function resetRepoForTesting(): void {
  holder.repo = undefined;
  holder.admin = undefined;
  holder.handle = undefined;
}

export { discoverRegistry, storageMode };
