import { describe, expect, it } from "vitest";
import { formatClockDateTime, formatClockTime, isoWithLocalOffset } from "@shared/time";

describe("schedule time context", () => {
  it("carries an offset that agrees with the wall clock it prints", () => {
    const now = new Date();
    const stamp = isoWithLocalOffset(now);
    // The whole point: parsing the string back must land on the same instant.
    // A UTC wall clock wearing a local offset would not.
    expect(Math.abs(new Date(stamp).getTime() - now.getTime())).toBeLessThan(1_000);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("stays consistent for a relative time the model would compute from it", () => {
    const now = new Date("2026-08-23T15:17:33Z");
    const inTenMinutes = new Date(now.getTime() + 10 * 60_000);
    // Adding to the printed instant must stay ahead of it, whatever the host
    // offset is. The old UTC-instant-plus-zone-name pairing failed this.
    expect(new Date(isoWithLocalOffset(inTenMinutes)).getTime()).toBeGreaterThan(
      new Date(isoWithLocalOffset(now)).getTime(),
    );
  });
});

describe("clock time display", () => {
  const afternoon = new Date(2026, 9, 3, 16, 13, 5);

  it("uses a 12-hour clock with an uppercase AM/PM even where the locale prefers 24 hours", () => {
    expect(afternoon.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })).toBe("16:13");
    expect(formatClockTime(afternoon, {}, "en-GB")).toMatch(/^4:13\sPM$/);
    expect(formatClockTime(new Date(2026, 9, 3, 9, 5), {}, "en-SG")).toMatch(/^9:05\sAM$/);
  });

  it("adds the date or seconds in the locale's own order", () => {
    expect(formatClockDateTime(afternoon, "en-GB")).toMatch(/^3 Oct 2026, 4:13\sPM$/);
    expect(formatClockDateTime(afternoon, "en-US")).toMatch(/^Oct 3, 2026, 4:13\sPM$/);
    expect(formatClockTime(afternoon, { second: "2-digit" }, "en-GB")).toMatch(/^4:13:05\sPM$/);
  });

  it("leaves a value it cannot read unchanged", () => {
    expect(formatClockDateTime("not a date")).toBe("not a date");
  });
});
