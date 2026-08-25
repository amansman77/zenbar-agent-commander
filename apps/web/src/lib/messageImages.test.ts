import { extractImageSegments, isRemoteImageUrl } from "./messageImages";

describe("extractImageSegments", () => {
  it("splits a backtick-quoted image path out from surrounding text", () => {
    const segments = extractImageSegments("증거: `docs/evidence/issue-86/foo.png` 확인했습니다.");
    expect(segments).toEqual([
      { type: "text", value: "증거: " },
      { type: "image", path: "docs/evidence/issue-86/foo.png" },
      { type: "text", value: " 확인했습니다." },
    ]);
  });

  it("finds a bare (non-backtick) image path and drops trailing punctuation", () => {
    const segments = extractImageSegments("저장 위치는 /tmp/evidence.png. 확인해주세요");
    expect(segments).toEqual([
      { type: "text", value: "저장 위치는 " },
      { type: "image", path: "/tmp/evidence.png" },
      { type: "text", value: ". 확인해주세요" },
    ]);
  });

  it("keeps a full URL intact as the image path", () => {
    const segments = extractImageSegments(
      "`https://github.com/yna-team/ohso/raw/main/docs/evidence/issue-75/card.png`"
    );
    expect(segments).toEqual([{ type: "image", path: "https://github.com/yna-team/ohso/raw/main/docs/evidence/issue-75/card.png" }]);
  });

  it("finds multiple images in one message", () => {
    const segments = extractImageSegments("- `a/one.png`\n- `a/two.jpg`");
    expect(segments.filter((s) => s.type === "image")).toEqual([
      { type: "image", path: "a/one.png" },
      { type: "image", path: "a/two.jpg" },
    ]);
  });

  it("returns the whole message as one text segment when there's no image", () => {
    const segments = extractImageSegments("작업을 완료했습니다. 파일: `README.md`");
    expect(segments).toEqual([{ type: "text", value: "작업을 완료했습니다. 파일: `README.md`" }]);
  });

  it("does not match non-image extensions", () => {
    const segments = extractImageSegments("커밋: `apps/api/src/index.ts`");
    expect(segments.every((s) => s.type === "text")).toBe(true);
  });
});

describe("isRemoteImageUrl", () => {
  it("is true for http(s) URLs", () => {
    expect(isRemoteImageUrl("https://example.com/a.png")).toBe(true);
    expect(isRemoteImageUrl("http://example.com/a.png")).toBe(true);
  });

  it("is false for local workspace-relative or absolute paths", () => {
    expect(isRemoteImageUrl("docs/evidence/a.png")).toBe(false);
    expect(isRemoteImageUrl("/tmp/a.png")).toBe(false);
  });
});
