/**
 * Calendar dates ('YYYY-MM-DD' strings) and instants (ISO strings).
 *
 * Rules:
 * - Calendar dates are compared as strings and never turned into Date objects for comparisons.
 * - 'now' and 'today' are always parameters; nothing here reads the clock.
 * - Day arithmetic uses pure integer civil-date maths (no Date, no DST surprises).
 * - The only Date <-> Ymd conversions for the browser calendar widget are toYmdLocal / fromYmdLocal.
 */
import type { Iso, Ymd } from "./types";

export const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_FULL = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Builds a Ymd from parts, or null when the parts are not a real calendar date. */
export function ymdFromParts(y: number, m: number, d: number): Ymd | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

function parseYmd(ymd: Ymd): { y: number; m: number; d: number } {
  const match = YMD_RE.exec(ymd);
  if (!match || !isValidYmd(ymd)) throw new RangeError(`Not a valid date: "${ymd}"`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function isValidYmd(s: string): boolean {
  if (typeof s !== "string") return false;
  const match = YMD_RE.exec(s);
  if (!match) return false;
  return ymdFromParts(Number(match[1]), Number(match[2]), Number(match[3])) !== null;
}

// Howard Hinnant's days_from_civil / civil_from_days (proleptic Gregorian, day 0 = 1970-01-01).
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}

export function addDays(ymd: Ymd, n: number): Ymd {
  const { y, m, d } = parseYmd(ymd);
  const out = civilFromDays(daysFromCivil(y, m, d) + Math.trunc(n));
  return `${pad4(out.y)}-${pad2(out.m)}-${pad2(out.d)}`;
}

/** b - a in whole days. */
export function daysBetween(a: Ymd, b: Ymd): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  return daysFromCivil(pb.y, pb.m, pb.d) - daysFromCivil(pa.y, pa.m, pa.d);
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockParts(
  instant: Date,
  timeZone: string,
): { y: number; m: number; d: number; hh: number; mm: number } {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : NaN;
  };
  let hh = get("hour");
  if (hh === 24) hh = 0; // some engines render midnight as 24 even with h23
  return { y: get("year"), m: get("month"), d: get("day"), hh, mm: get("minute") };
}

function toInstant(iso: Iso): Date {
  const date = new Date(iso);
  if (typeof iso !== "string" || Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a valid instant: "${String(iso)}"`);
  }
  return date;
}

/** Today's calendar date in a time zone. `now` is passed in; nothing here reads the clock. */
export function todayIn(timeZone: string, now: Date): Ymd {
  const { y, m, d } = wallClockParts(now, timeZone);
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

/** The calendar date of an instant in a time zone. Throws RangeError for an invalid instant. */
export function ymdFromInstant(iso: Iso, timeZone: string): Ymd {
  return todayIn(timeZone, toInstant(iso));
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** '12 Nov 2026'. An invalid input is returned unchanged. */
export function formatYmd(ymd: Ymd): string {
  if (!isValidYmd(ymd)) return String(ymd);
  const { y, m, d } = parseYmd(ymd);
  return `${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

/** '24 Oct 2026, 14:05' in the given time zone. An invalid input is returned unchanged. */
export function formatInstant(iso: Iso, timeZone: string): string {
  let instant: Date;
  try {
    instant = toInstant(iso);
  } catch {
    return String(iso);
  }
  const { y, m, d, hh, mm } = wallClockParts(instant, timeZone);
  return `${d} ${MONTH_SHORT[m - 1]} ${y}, ${pad2(hh)}:${pad2(mm)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 'just now', '5m ago', '3h ago', '2d ago', and the date ('12 Nov 2026') once more than 30 days have passed.
 * Instants more than a minute in the future also show the date. The date is taken in `timeZone` (default UTC).
 */
export function formatRelative(iso: Iso, now: Iso, timeZone = "UTC"): string {
  let then: Date;
  let current: Date;
  try {
    then = toInstant(iso);
    current = toInstant(now);
  } catch {
    return String(iso);
  }
  const diff = current.getTime() - then.getTime();
  if (diff < -MINUTE) return formatYmd(todayIn(timeZone, then));
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days <= 30) return `${days}d ago`;
  return formatYmd(todayIn(timeZone, then));
}

// ---------------------------------------------------------------------------
// Typed entry (day-first)
// ---------------------------------------------------------------------------

function monthFromName(name: string): number | null {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return null;
  if (n === "sept") return 9;
  const idx = MONTH_FULL.findIndex((full) => full.startsWith(n));
  return idx === -1 ? null : idx + 1;
}

function expandYear(text: string): number {
  const y = Number(text);
  return text.length <= 2 ? 2000 + y : y;
}

/** For a day and month without a year: the year that puts the date nearest to today (within about 6 months). */
function nearestYear(m: number, d: number, today: Ymd): Ymd | null {
  const { y } = parseYmd(today);
  let best: Ymd | null = null;
  let bestDistance = Infinity;
  for (const candidateYear of [y - 1, y, y + 1]) {
    const candidate = ymdFromParts(candidateYear, m, d);
    if (!candidate) continue;
    const distance = Math.abs(daysBetween(today, candidate));
    // Ties prefer the later (future) date because candidates are visited in ascending order.
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Parses typed date input, day-first. Returns null when the text is not a date.
 * Accepts: '12/11/2026', '12-11-2026', '12.11.26', '12/11', '12 Nov 2026', '12 Nov', 'Nov 12', '2026-11-12',
 * 't' / 'today', 'tomorrow', 'yesterday', '+3d', '+2w', '-1d' (a bare '+3' means days).
 */
export function parseDateInput(text: string, today: Ymd): Ymd | null {
  if (typeof text !== "string" || !isValidYmd(today)) return null;
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  if (s === "t" || s === "today") return today;
  if (s === "tomorrow" || s === "tmr") return addDays(today, 1);
  if (s === "yesterday") return addDays(today, -1);

  let match = /^([+-]) ?(\d{1,4}) ?(d|day|days|w|wk|wks|week|weeks)?$/.exec(s);
  if (match) {
    const n = Number(match[2]) * (match[3] && match[3].startsWith("w") ? 7 : 1);
    return addDays(today, match[1] === "-" ? -n : n);
  }

  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) return ymdFromParts(Number(match[1]), Number(match[2]), Number(match[3]));

  // Day-first numeric: 12/11/2026, 12-11-2026, 12.11.26
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (match) return ymdFromParts(expandYear(match[3]), Number(match[2]), Number(match[1]));

  // Day-first numeric without a year: 12/11, 12-11
  match = /^(\d{1,2})[/.-](\d{1,2})$/.exec(s);
  if (match) return nearestYear(Number(match[2]), Number(match[1]), today);

  // 12 Nov 2026, 12-Nov-2026, 12 November, 12nov
  match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]?([a-z]+\.?)(?:,?[ -](\d{2}|\d{4}))?$/.exec(s);
  if (match) {
    const m = monthFromName(match[2]);
    if (m === null) return null;
    const d = Number(match[1]);
    return match[3] ? ymdFromParts(expandYear(match[3]), m, d) : nearestYear(m, d, today);
  }

  // Nov 12 2026, Nov 12, 2026, Nov 12
  match = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(s);
  if (match) {
    const m = monthFromName(match[1]);
    if (m === null) return null;
    const d = Number(match[2]);
    return match[3] ? ymdFromParts(Number(match[3]), m, d) : nearestYear(m, d, today);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Calendar widget boundary (the only place Date objects meet Ymd)
// ---------------------------------------------------------------------------

/** Ymd from the LOCAL parts of a Date (what a calendar widget shows). */
export function toYmdLocal(d: Date): Ymd {
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** A local-midnight Date for a Ymd (for a calendar widget). */
export function fromYmdLocal(ymd: Ymd): Date {
  const { y, m, d } = parseYmd(ymd);
  const date = new Date(y, m - 1, d);
  if (y < 100) date.setFullYear(y);
  return date;
}
