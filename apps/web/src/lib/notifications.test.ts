import { isNotificationPermissionGranted, isNotifyWorthyTransition } from "./notifications";

describe("isNotifyWorthyTransition", () => {
  it("notifies when an active task becomes terminal", () => {
    expect(isNotifyWorthyTransition("running", "completed")).toBe(true);
    expect(isNotifyWorthyTransition("queued", "failed")).toBe(true);
    expect(isNotifyWorthyTransition("waiting_result_approval", "stopped")).toBe(true);
  });

  it("does not notify when the previous status was already terminal", () => {
    // Regression: without this, every already-completed/failed task present
    // on the very first poll after page load would fire at once (the
    // "previous" snapshot in that case is really just "unknown", not
    // "active" -- callers pass null for that case, covered below).
    expect(isNotifyWorthyTransition("completed", "completed")).toBe(false);
    expect(isNotifyWorthyTransition("failed", "failed")).toBe(false);
  });

  it("does not notify when there is no previous status to compare against", () => {
    // This is what the very first snapshot after mount/reload looks like --
    // must not fire for tasks that were already done before we started
    // watching.
    expect(isNotifyWorthyTransition(null, "completed")).toBe(false);
  });

  it("does not notify while a task is still active", () => {
    expect(isNotifyWorthyTransition("running", "running")).toBe(false);
    expect(isNotifyWorthyTransition("queued", "running")).toBe(false);
  });

  it("does not notify when there is no current status", () => {
    expect(isNotifyWorthyTransition("running", null)).toBe(false);
  });
});

describe("isNotificationPermissionGranted", () => {
  const original = (window as { Notification?: { permission: string } }).Notification;

  afterEach(() => {
    (window as { Notification?: unknown }).Notification = original;
  });

  it("is true only when the browser's live permission is actually granted", () => {
    (window as { Notification?: { permission: string } }).Notification = { permission: "granted" };
    expect(isNotificationPermissionGranted()).toBe(true);
  });

  it("is false when permission was revoked/blocked after being enabled", () => {
    // The exact drift this exists for: something (localStorage, React
    // state) still says "enabled", but the browser itself now says no.
    (window as { Notification?: { permission: string } }).Notification = { permission: "denied" };
    expect(isNotificationPermissionGranted()).toBe(false);
  });

  it("is false when the browser never asked at all", () => {
    (window as { Notification?: { permission: string } }).Notification = { permission: "default" };
    expect(isNotificationPermissionGranted()).toBe(false);
  });

  it("is false when the Notification API doesn't exist in this browser", () => {
    delete (window as { Notification?: unknown }).Notification;
    expect(isNotificationPermissionGranted()).toBe(false);
  });
});
