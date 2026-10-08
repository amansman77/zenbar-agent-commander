import { describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  it("uses navigator.clipboard.writeText when available", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const result = await copyToClipboard("hello world");
    expect(result).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("hello world");
  });

  it("falls back to document.execCommand when navigator.clipboard is unavailable", async () => {
    // Temporarily remove navigator.clipboard
    const originalClipboard = navigator.clipboard;
    delete (navigator as unknown as Record<string, unknown>).clipboard;

    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    const result = await copyToClipboard("fallback text");
    expect(result).toBe(true);
    expect(execMock).toHaveBeenCalledWith("copy");

    // Restore
    Object.assign(navigator, { clipboard: originalClipboard });
  });

  it("falls back to document.execCommand when writeText rejects", async () => {
    const originalClipboard = navigator.clipboard;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
    });
    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    await expect(copyToClipboard("denied text")).resolves.toBe(true);
    expect(execMock).toHaveBeenCalledWith("copy");

    Object.assign(navigator, { clipboard: originalClipboard });
  });
});
