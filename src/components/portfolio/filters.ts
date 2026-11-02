/**
 * Portfolio filters in the URL: `/portfolio?status=active,on-hold&customer=sita&type=project&q=heathrow&waiting=1&dated=1`.
 * Defaults (Active only, nothing else) are left out, so the bare `/portfolio` means "the defaults". Shared by the
 * server page (parsing) and the client screen (writing), so it stays free of server and browser APIs.
 */
import type { ProjectStatus } from "@/domain/types";

export interface PortfolioQuery {
  status: ProjectStatus[];
  customer: string[];
  type: string[];
  q: string;
  /** "+ Waiting" chip of My open items. */
  waiting: boolean;
  /** "Include date-driven items" chip of My open items. */
  dated: boolean;
}

export const FILTER_PARAMS = ["status", "customer", "type", "q", "waiting", "dated"] as const;

const STATUS_PARAM: Record<ProjectStatus, string> = { ACTIVE: "active", ON_HOLD: "on-hold", CLOSED: "closed" };
const STATUS_ORDER: ProjectStatus[] = ["ACTIVE", "ON_HOLD", "CLOSED"];

export const DEFAULT_QUERY: PortfolioQuery = { status: ["ACTIVE"], customer: [], type: [], q: "", waiting: false, dated: false };

type Getter = (key: string) => string | null | undefined;

function list(v: string | null | undefined, max = 50): string[] {
  if (!v) return [];
  return [
    ...new Set(
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 200),
    ),
  ].slice(0, max);
}

export function parsePortfolioQuery(get: Getter): PortfolioQuery {
  const statuses = list(get("status"))
    .map((s) => STATUS_ORDER.find((st) => STATUS_PARAM[st] === s.toLowerCase() || st === s.toUpperCase()))
    .filter((s): s is ProjectStatus => Boolean(s));
  return {
    status: statuses.length ? STATUS_ORDER.filter((s) => statuses.includes(s)) : ["ACTIVE"],
    customer: list(get("customer")),
    type: list(get("type")),
    q: (get("q") ?? "").trim().slice(0, 200),
    waiting: get("waiting") === "1",
    dated: get("dated") === "1",
  };
}

/** Query string without the leading "?" ("" for the defaults). */
export function serializePortfolioQuery(q: PortfolioQuery): string {
  const p = new URLSearchParams();
  const status = STATUS_ORDER.filter((s) => q.status.includes(s));
  if (!(status.length === 1 && status[0] === "ACTIVE") && status.length) p.set("status", status.map((s) => STATUS_PARAM[s]).join(","));
  if (q.customer.length) p.set("customer", q.customer.join(","));
  if (q.type.length) p.set("type", q.type.join(","));
  if (q.q.trim()) p.set("q", q.q.trim());
  if (q.waiting) p.set("waiting", "1");
  if (q.dated) p.set("dated", "1");
  return p.toString().replace(/%2C/g, ",");
}

export function hasFilterParams(get: Getter): boolean {
  return FILTER_PARAMS.some((k) => {
    const v = get(k);
    return v !== null && v !== undefined;
  });
}

export function isDefaultGridFilter(q: PortfolioQuery): boolean {
  return q.status.length === 1 && q.status[0] === "ACTIVE" && !q.customer.length && !q.type.length && !q.q;
}
