import { formatRemainingTime } from "./format";

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
