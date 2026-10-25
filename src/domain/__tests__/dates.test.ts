import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatInstant,
  formatRelative,
  formatYmd,
  fromYmdLocal,
  isValidYmd,
  parseDateInput,
  toYmdLocal,
  todayIn,
  ymdFromInstant,
} from "@/domain/dates";

describe("todayIn", () => {
  it("SGT vs UTC at 2026-10-24T16:30Z: Singapore is already on the 25th", () => {
    const now = new Date("2026-10-24T16:30:00Z");
    expect(todayIn("Asia/Singapore", now)).toBe("2026-10-25");
    expect(todayIn("UTC", now)).toBe("2026-10-24");
  });

  it.each<[string, string, string]>([
    ["2026-10-24T15:59:59.999Z", "Asia/Singapore", "2026-10-24"],
    ["2026-10-24T16:00:00.000Z", "Asia/Singapore", "2026-10-25"],
    ["2026-12-31T23:30:00.000Z", "UTC", "2026-12-31"],
    ["2026-12-31T16:00:00.000Z", "Asia/Singapore", "2027-01-01"],
    ["2026-03-29T00:30:00.000Z", "Europe/London", "2026-03-29"],
    ["2026-10-25T03:00:00.000Z", "America/Los_Angeles", "2026-10-24"],
  ])("%s in %s is %s", (iso, tz, expected) => {
    expect(todayIn(tz, new Date(iso))).toBe(expected);
    expect(ymdFromInstant(iso, tz)).toBe(expected);
  });

  it("ymdFromInstant rejects an invalid instant", () => {
    expect(() => ymdFromInstant("yesterday", "UTC")).toThrow(RangeError);
  });
});

describe("isValidYmd", () => {
  it.each<[string, boolean]>([
    ["2026-11-12", true],
    ["2028-02-29", true],
    ["2000-02-29", true],
    ["1900-02-29", false],
    ["2026-02-29", false],
    ["2026-04-31", false],
    ["2026-00-10", false],
    ["2026-13-01", false],
    ["2026-1-01", false],
    ["2026-11-12T00:00:00Z", false],
    ["12/11/2026", false],
    ["", false],
  ])("%j -> %s", (s, valid) => {
    expect(isValidYmd(s)).toBe(valid);
  });
});

describe("formatting", () => {
  it.each<[string, string]>([
    ["2026-11-12", "12 Nov 2026"],
    ["2027-01-01", "1 Jan 2027"],
    ["2028-12-31", "31 Dec 2028"],
    ["2026-05-09", "9 May 2026"],
  ])("formatYmd(%s) = %s", (ymd, text) => {
    expect(formatYmd(ymd)).toBe(text);
  });

  it("formatYmd returns invalid input unchanged", () => {
    expect(formatYmd("2026-02-30")).toBe("2026-02-30");
  });

  it.each<[string, string, string]>([
    ["2026-10-24T06:05:00.000Z", "Asia/Singapore", "24 Oct 2026, 14:05"],
    ["2026-10-24T16:30:00.000Z", "Asia/Singapore", "25 Oct 2026, 00:30"],
    ["2026-10-24T16:30:00.000Z", "UTC", "24 Oct 2026, 16:30"],
    ["2026-10-24T16:00:00.000Z", "Asia/Singapore", "25 Oct 2026, 00:00"],
    ["2027-01-01T09:07:00.000Z", "UTC", "1 Jan 2027, 09:07"],
  ])("formatInstant(%s, %s) = %s", (iso, tz, text) => {
    expect(formatInstant(iso, tz)).toBe(text);
  });

  const NOW = "2026-10-24T12:00:00.000Z";
  it.each<[string, string]>([
    ["2026-10-24T12:00:00.000Z", "just now"],
    ["2026-10-24T11:59:31.000Z", "just now"],
    ["2026-10-24T12:00:30.000Z", "just now"], // slight clock skew
    ["2026-10-24T11:55:00.000Z", "5m ago"],
    ["2026-10-24T11:00:01.000Z", "59m ago"],
    ["2026-10-24T09:00:00.000Z", "3h ago"],
    ["2026-10-23T12:00:01.000Z", "23h ago"],
    ["2026-10-22T12:00:00.000Z", "2d ago"],
    ["2026-09-24T12:00:00.000Z", "30d ago"],
    ["2026-09-23T12:00:00.000Z", "23 Sep 2026"],
    ["2025-11-12T12:00:00.000Z", "12 Nov 2025"],
    ["2026-11-12T12:00:00.000Z", "12 Nov 2026"], // in the future
  ])("formatRelative(%s) = %s", (iso, text) => {
    expect(formatRelative(iso, NOW)).toBe(text);
  });

  it("formatRelative shows the date in the given time zone", () => {
    expect(formatRelative("2026-08-31T20:00:00.000Z", NOW, "Asia/Singapore")).toBe("1 Sep 2026");
    expect(formatRelative("2026-08-31T20:00:00.000Z", NOW)).toBe("31 Aug 2026");
  });
});

describe("parseDateInput (day-first)", () => {
  const TODAY = "2026-10-25";
  it.each<[string, string | null]>([
    ["12/11/2026", "2026-11-12"],
    ["12-11-2026", "2026-11-12"],
    ["12.11.2026", "2026-11-12"],
    ["1/2/2027", "2027-02-01"],
    ["12/11/26", "2026-11-12"],
    ["12 Nov 2026", "2026-11-12"],
    ["12 nov 2026", "2026-11-12"],
    ["12 November 2026", "2026-11-12"],
    ["12-Nov-2026", "2026-11-12"],
    ["3 Sept 2026", "2026-09-03"],
    ["Nov 12 2026", "2026-11-12"],
    ["Nov 12, 2026", "2026-11-12"],
    ["2026-11-12", "2026-11-12"],
    ["2026-1-5", "2026-01-05"],
    ["  12 Nov  ", "2026-11-12"],
    // year inferred so the date is within +-6 months of today (25 Oct 2026)
    ["12 Nov", "2026-11-12"],
    ["3 Jan", "2027-01-03"],
    ["20 Apr", "2027-04-20"],
    ["1 May", "2026-05-01"],
    ["1 Jun", "2026-06-01"],
    ["12/11", "2026-11-12"],
    ["5/1", "2027-01-05"],
    // shortcuts
    ["t", TODAY],
    ["T", TODAY],
    ["today", TODAY],
    ["Today", TODAY],
    ["tomorrow", "2026-10-26"],
    ["yesterday", "2026-10-24"],
    ["+3d", "2026-10-28"],
    ["+3", "2026-10-28"],
    ["+2w", "2026-11-08"],
    ["-1d", "2026-10-24"],
    ["- 2 weeks", "2026-10-11"],
    ["+10d", "2026-11-04"],
    // not dates
    ["", null],
    ["   ", null],
    ["31/4/2026", null],
    ["29/2/2026", null],
    ["29 Feb", null], // no leap day within 6 months
    ["32 Jan 2026", null],
    ["12 Foo 2026", null],
    ["11/12/2026 10:00", null],
    ["next week", null],
    ["12", null],
  ])("%j -> %s", (text, expected) => {
    expect(parseDateInput(text, TODAY)).toBe(expected);
  });

  it("'12/11/2026' is day-first (12 Nov), never 11 Dec", () => {
    expect(parseDateInput("12/11/2026", TODAY)).toBe("2026-11-12");
  });

  it("year inference finds 29 Feb when a leap day is near", () => {
    expect(parseDateInput("29 Feb", "2027-12-01")).toBe("2028-02-29");
  });

  it("year inference across the year end", () => {
    expect(parseDateInput("28 Dec", "2027-01-10")).toBe("2026-12-28");
    expect(parseDateInput("5 Jan", "2026-12-20")).toBe("2027-01-05");
  });
});

describe("day arithmetic", () => {
  it.each<[string, number, string]>([
    ["2026-10-25", 1, "2026-10-26"],
    ["2026-10-31", 1, "2026-11-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-01-01", -1, "2026-12-31"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2028-02-29", 1, "2028-03-01"],
    ["2026-02-28", 1, "2026-03-01"],
    ["2026-03-29", 1, "2026-03-30"], // DST day in Europe: no effect
    ["2026-10-25", 0, "2026-10-25"],
    ["2026-10-25", 365, "2027-10-25"],
    ["2026-10-25", -3650, "2016-10-27"],
  ])("addDays(%s, %i) = %s", (ymd, n, expected) => {
    expect(addDays(ymd, n)).toBe(expected);
  });

  it.each<[string, string, number]>([
    ["2026-10-25", "2026-10-25", 0],
    ["2026-10-25", "2026-10-26", 1],
    ["2026-10-26", "2026-10-25", -1],
    ["2026-01-01", "2027-01-01", 365],
    ["2028-01-01", "2029-01-01", 366],
    ["2026-02-28", "2026-03-01", 1],
  ])("daysBetween(%s, %s) = %i", (a, b, n) => {
    expect(daysBetween(a, b)).toBe(n);
    expect(addDays(a, n)).toBe(b);
  });

  it("addDays and daysBetween reject invalid dates", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => daysBetween("x", "2026-01-01")).toThrow(RangeError);
  });
});

describe("calendar widget boundary", () => {
  it.each([["2026-11-12"], ["2028-02-29"], ["2026-01-01"], ["2026-12-31"], ["2026-03-29"]])(
    "fromYmdLocal / toYmdLocal round-trip %s via local parts",
    (ymd) => {
      const d = fromYmdLocal(ymd);
      expect(d.getHours()).toBe(0);
      expect(toYmdLocal(d)).toBe(ymd);
    },
  );

  it("toYmdLocal uses local parts, not UTC", () => {
    const d = new Date(2026, 10, 12, 23, 59); // 12 Nov 2026, 23:59 local
    expect(toYmdLocal(d)).toBe("2026-11-12");
  });
});
