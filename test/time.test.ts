import { describe, expect, it } from "vitest";
import {
  isWithinBusinessHours,
  localTime,
  nextOutsideBusinessHours,
  parseHHMM,
  secondsBetween,
} from "../src/lib/time";
import type { BusinessHours } from "../src/types";

const WEEKDAYS = [1, 2, 3, 4, 5];
const warsaw: BusinessHours = {
  timezone: "Europe/Warsaw",
  days: WEEKDAYS,
  start: "09:00",
  end: "17:00",
};
const newYork: BusinessHours = {
  timezone: "America/New_York",
  days: WEEKDAYS,
  start: "09:00",
  end: "17:00",
};
// Only Friday starts a window that runs 22:00 -> 06:00 Saturday.
const overnight: BusinessHours = { timezone: "UTC", days: [5], start: "22:00", end: "06:00" };

const at = (iso: string): Date => new Date(iso);

describe("parseHHMM", () => {
  it("parses valid times", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("09:30")).toBe(570);
    expect(parseHHMM("23:59")).toBe(1439);
  });

  it.each(["", "9:00", "24:00", "12:60", "12:5", "ab:cd", "12-30", "12:30:00", " 12:30"])(
    "rejects %j",
    (value) => {
      expect(() => parseHHMM(value)).toThrow(/invalid HH:MM/);
    },
  );
});

describe("localTime", () => {
  it("resolves weekday and minutes in the timezone (2026-11-02 is a Monday)", () => {
    expect(localTime(at("2026-11-02T08:00:00Z"), "Europe/Warsaw")).toEqual({
      weekday: 1,
      minutes: 9 * 60,
    });
    expect(localTime(at("2026-11-02T23:30:00Z"), "Europe/Warsaw")).toEqual({
      weekday: 2,
      minutes: 30,
    });
  });
});

describe("isWithinBusinessHours in Europe/Warsaw", () => {
  it("is inside during the working day (CET, UTC+1)", () => {
    expect(isWithinBusinessHours(at("2026-11-02T08:00:00Z"), warsaw)).toBe(true); // 09:00
    expect(isWithinBusinessHours(at("2026-11-02T12:00:00Z"), warsaw)).toBe(true);
  });

  it("start is inclusive, end is exclusive", () => {
    expect(isWithinBusinessHours(at("2026-11-02T07:59:00Z"), warsaw)).toBe(false); // 08:59
    expect(isWithinBusinessHours(at("2026-11-02T08:00:00Z"), warsaw)).toBe(true); // 09:00
    expect(isWithinBusinessHours(at("2026-11-02T15:59:00Z"), warsaw)).toBe(true); // 16:59
    expect(isWithinBusinessHours(at("2026-11-02T16:00:00Z"), warsaw)).toBe(false); // 17:00
  });

  it("is outside on weekends", () => {
    expect(isWithinBusinessHours(at("2026-11-07T10:00:00Z"), warsaw)).toBe(false); // Saturday
    expect(isWithinBusinessHours(at("2026-11-08T10:00:00Z"), warsaw)).toBe(false); // Sunday
  });

  it("uses the local day, not the UTC day, at the day boundary", () => {
    // Sunday 23:30Z is Monday 00:30 in Warsaw: right day, wrong time.
    expect(isWithinBusinessHours(at("2026-11-01T23:30:00Z"), warsaw)).toBe(false);
    // Friday 16:30Z = 17:30 Warsaw: after close.
    expect(isWithinBusinessHours(at("2026-11-06T16:30:00Z"), warsaw)).toBe(false);
  });
});

describe("isWithinBusinessHours in America/New_York", () => {
  it("applies EST (UTC-5) after the 2026-11-01 DST end", () => {
    expect(isWithinBusinessHours(at("2026-11-02T14:00:00Z"), newYork)).toBe(true); // 09:00
    expect(isWithinBusinessHours(at("2026-11-02T13:59:00Z"), newYork)).toBe(false); // 08:59
    expect(isWithinBusinessHours(at("2026-11-02T22:00:00Z"), newYork)).toBe(false); // 17:00
  });

  it("is the previous local day when UTC has already rolled over", () => {
    // Saturday 2026-11-07 02:00Z is Friday 21:00 in New York: Friday but after hours.
    expect(isWithinBusinessHours(at("2026-11-07T02:00:00Z"), newYork)).toBe(false);
    // Monday 2026-11-02 03:00Z is Sunday 22:00 in New York.
    expect(isWithinBusinessHours(at("2026-11-02T03:00:00Z"), newYork)).toBe(false);
  });
});

describe("window crossing midnight (22:00-06:00)", () => {
  it("is inside late on a listed day", () => {
    expect(isWithinBusinessHours(at("2026-11-06T22:00:00Z"), overnight)).toBe(true); // Fri 22:00
    expect(isWithinBusinessHours(at("2026-11-06T23:59:00Z"), overnight)).toBe(true);
  });

  it("is inside in the early hours after a listed day", () => {
    expect(isWithinBusinessHours(at("2026-11-07T00:00:00Z"), overnight)).toBe(true); // Sat 00:00
    expect(isWithinBusinessHours(at("2026-11-07T05:59:00Z"), overnight)).toBe(true);
  });

  it("end is exclusive", () => {
    expect(isWithinBusinessHours(at("2026-11-07T06:00:00Z"), overnight)).toBe(false);
  });

  it("is outside during the day and on unlisted days", () => {
    expect(isWithinBusinessHours(at("2026-11-06T12:00:00Z"), overnight)).toBe(false); // Fri noon
    expect(isWithinBusinessHours(at("2026-11-06T05:00:00Z"), overnight)).toBe(false); // Fri 05:00 (Thu not listed)
    expect(isWithinBusinessHours(at("2026-11-07T23:00:00Z"), overnight)).toBe(false); // Sat 23:00
  });

  it("works in a non-UTC timezone", () => {
    const warsawNight: BusinessHours = { ...overnight, timezone: "Europe/Warsaw" };
    // Friday 2026-11-06 22:30Z = 23:30 Warsaw, in window.
    expect(isWithinBusinessHours(at("2026-11-06T22:30:00Z"), warsawNight)).toBe(true);
    // Saturday 2026-11-07 04:30Z = 05:30 Warsaw, still in window.
    expect(isWithinBusinessHours(at("2026-11-07T04:30:00Z"), warsawNight)).toBe(true);
    // Saturday 2026-11-07 05:30Z = 06:30 Warsaw, closed.
    expect(isWithinBusinessHours(at("2026-11-07T05:30:00Z"), warsawNight)).toBe(false);
  });
});

describe("DST transition in Europe/Warsaw (2026-03-29)", () => {
  const allDays: BusinessHours = { ...warsaw, days: [0, 1, 2, 3, 4, 5, 6] };

  it("shifts the local clock from CET to CEST at 01:00Z", () => {
    expect(localTime(at("2026-03-29T00:30:00Z"), "Europe/Warsaw").minutes).toBe(90); // 01:30 CET
    expect(localTime(at("2026-03-29T01:00:00Z"), "Europe/Warsaw").minutes).toBe(180); // 03:00 CEST
  });

  it("opens at 07:00Z (09:00 CEST) on the transition day", () => {
    expect(isWithinBusinessHours(at("2026-03-29T06:59:00Z"), allDays)).toBe(false);
    expect(isWithinBusinessHours(at("2026-03-29T07:00:00Z"), allDays)).toBe(true);
  });

  it("opened at 08:00Z (09:00 CET) the day before", () => {
    expect(isWithinBusinessHours(at("2026-03-28T07:59:00Z"), allDays)).toBe(false);
    expect(isWithinBusinessHours(at("2026-03-28T08:00:00Z"), allDays)).toBe(true);
  });

  it("closes at 15:00Z (17:00 CEST) on the transition day", () => {
    expect(isWithinBusinessHours(at("2026-03-29T14:59:00Z"), allDays)).toBe(true);
    expect(isWithinBusinessHours(at("2026-03-29T15:00:00Z"), allDays)).toBe(false);
  });
});

describe("nextOutsideBusinessHours", () => {
  const utc: BusinessHours = { timezone: "UTC", days: WEEKDAYS, start: "08:00", end: "18:00" };

  it("returns the same instant when already outside", () => {
    const date = at("2026-11-02T20:00:00Z");
    expect(nextOutsideBusinessHours(date, utc).toISOString()).toBe(date.toISOString());
  });

  it("returns the first 15-minute step after the window closes", () => {
    expect(nextOutsideBusinessHours(at("2026-11-02T10:00:00Z"), utc).toISOString()).toBe(
      "2026-11-02T18:00:00.000Z",
    );
    expect(nextOutsideBusinessHours(at("2026-11-02T17:50:00Z"), utc).toISOString()).toBe(
      "2026-11-02T18:05:00.000Z",
    );
  });

  it("skips ahead across a window that wraps midnight", () => {
    const next = nextOutsideBusinessHours(at("2026-11-06T22:30:00Z"), overnight);
    expect(next.toISOString()).toBe("2026-11-07T06:00:00.000Z");
    expect(isWithinBusinessHours(next, overnight)).toBe(false);
  });

  it("throws when business hours cover the whole week", () => {
    const always: BusinessHours = {
      timezone: "UTC",
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "00:00",
    };
    expect(() => nextOutsideBusinessHours(at("2026-11-02T10:00:00Z"), always)).toThrow(
      /no after-hours slot/,
    );
  });
});

describe("secondsBetween", () => {
  it("floors the elapsed seconds", () => {
    expect(secondsBetween("2026-11-03T10:00:00.000Z", at("2026-11-03T10:03:00.900Z"))).toBe(180);
  });
});
