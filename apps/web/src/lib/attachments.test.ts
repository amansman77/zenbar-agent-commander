import { attachmentImageType, attachmentSelectionError, attachmentSize, MAX_ATTACHMENT_BYTES, pastedImageFiles } from "./attachments";

describe("attachment selection", () => {
  it("previews raster images without treating active documents as images", () => {
    expect(attachmentImageType("스크린샷.PNG")).toBe("image/png");
    expect(attachmentImageType("photo.JpEg")).toBe("image/jpeg");
    expect(attachmentImageType("animation.webp")).toBe("image/webp");
    for (const name of ["picture.svg", "page.html", "notes.txt", "photo.png.html", "no-extension"]) {
      expect(attachmentImageType(name)).toBeNull();
    }
  });
  it("allows multiple files of any format", () => {
    expect(attachmentSelectionError([new File(["data"], "요구사항.pdf"), new File(["data"], "config.json")])).toBeNull();
  });

  it("rejects empty, oversized and too many files", () => {
    expect(attachmentSelectionError([new File([], "empty.txt")])).toContain("빈 파일");
    expect(attachmentSelectionError([new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "large.pdf")])).toContain("10MB");
    expect(attachmentSelectionError(Array.from({ length: 11 }, () => new File(["a"], "file.txt")))).toContain("10개");
  });

  it("names pasted screenshots apart and leaves non-images to the textarea", () => {
    const now = new Date(2026, 10, 27, 9, 5, 3);
    const files = pastedImageFiles([
      new File(["a"], "image.png", { type: "image/png" }),
      new File(["b"], "image.png", { type: "image/jpeg" }),
      new File(["<svg/>"], "drawing.svg", { type: "image/svg+xml" }),
      new File(["text"], "notes.txt", { type: "text/plain" }),
    ], now);
    expect(files.map((file) => file.name)).toEqual([
      "붙여넣은 이미지 2026-11-27 09.05.03.png",
      "붙여넣은 이미지 2026-11-27 09.05.03-2.jpg",
    ]);
    expect(files.map((file) => attachmentImageType(file.name))).toEqual(["image/png", "image/jpeg"]);
  });

  it("formats sizes for the compose bar and transcript", () => {
    expect(attachmentSize(1)).toBe("1 KB");
    expect(attachmentSize(1024 * 1024)).toBe("1.0 MB");
  });
});
