import { formatFullTimestamp, formatMessageTime, formatRemainingTime } from "./format";

describe("formatRemainingTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats a multi-day remaining time in days and hours", () => {
    expect(formatRemainingTime("2026-08-27T18:00:00Z")).toBe("5일 18시간 후");
  });

  it("formats a sub-day remaining time in hours and minutes", () => {
    expect(formatRemainingTime("2026-08-22T03:42:00Z")).toBe("3시간 42분 후");
  });

  it("formats a sub-hour remaining time in minutes only", () => {
    expect(formatRemainingTime("2026-08-22T00:15:00Z")).toBe("15분 후");
  });

  it("reports an already-past reset as resetting soon instead of a negative duration", () => {
    // A cached usage response can be stale enough that the window has
    // already reset by the time it's rendered -- must not show "-5분 후".
    expect(formatRemainingTime("2026-08-21T23:00:00Z")).toBe("곧 초기화");
  });

  it("returns null for an unparseable timestamp instead of throwing", () => {
    expect(formatRemainingTime("not-a-date")).toBeNull();
  });
});

describe("formatMessageTime", () => {
  // Local-time constructors, so these hold in any test timezone.
  const now = new Date(2026, 9, 9, 22, 0);

  it("shows only the clock for a message from today", () => {
    expect(formatMessageTime(new Date(2026, 9, 9, 21, 33).toISOString(), now)).toBe("오후 9:33");
    expect(formatMessageTime(new Date(2026, 9, 9, 0, 5).toISOString(), now)).toBe("오전 12:05");
    expect(formatMessageTime(new Date(2026, 9, 9, 12, 0).toISOString(), now)).toBe("오후 12:00");
  });

  it("adds the date for an earlier day, and the year for an earlier year", () => {
    expect(formatMessageTime(new Date(2026, 9, 8, 9, 7).toISOString(), now)).toBe("10월 8일 오전 9:07");
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("2025년 12월 31일 오후 11:59");
  });

  it("reads a UTC timestamp with its offset as the same instant", () => {
    const instant = new Date(2026, 9, 9, 21, 33);
    expect(formatMessageTime(instant.toISOString(), now)).toBe(formatMessageTime(instant.toString(), now));
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatMessageTime("not a date", now)).toBe("");
  });
});

describe("formatFullTimestamp", () => {
  it("includes the date and seconds", () => {
    expect(formatFullTimestamp(new Date(2026, 9, 9, 21, 33, 8).toISOString())).toBe("2026년 10월 9일 오후 9:33:08");
  });
});
