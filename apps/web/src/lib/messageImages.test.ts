import { classifyReferencePath, extractMessageSegments, isRemoteImageUrl } from "./messageImages";

describe("extractMessageSegments", () => {
  it("splits a backtick-quoted image path out from surrounding text", () => {
    const segments = extractMessageSegments("증거: `docs/evidence/issue-86/foo.png` 확인했습니다.");
    expect(segments).toEqual([
      { type: "text", value: "증거: " },
      { type: "image", path: "docs/evidence/issue-86/foo.png" },
      { type: "text", value: " 확인했습니다." },
    ]);
  });

  it("finds a bare (non-backtick) image path and drops trailing punctuation", () => {
    const segments = extractMessageSegments("저장 위치는 /tmp/evidence.png. 확인해주세요");
    expect(segments).toEqual([
      { type: "text", value: "저장 위치는 " },
      { type: "image", path: "/tmp/evidence.png" },
      { type: "text", value: ". 확인해주세요" },
    ]);
  });

  it("keeps a full URL intact as the image path", () => {
    const segments = extractMessageSegments(
      "`https://github.com/yna-team/ohso/raw/main/docs/evidence/issue-75/card.png`"
    );
    expect(segments).toEqual([{ type: "image", path: "https://github.com/yna-team/ohso/raw/main/docs/evidence/issue-75/card.png" }]);
  });

  it("finds multiple images in one message", () => {
    const segments = extractMessageSegments("- `a/one.png`\n- `a/two.jpg`");
    expect(segments.filter((s) => s.type === "image")).toEqual([
      { type: "image", path: "a/one.png" },
      { type: "image", path: "a/two.jpg" },
    ]);
  });

  it("extracts the path from markdown image syntax, stripping a sandbox: scheme", () => {
    // Verbatim from the task event that used to render as a broken path.
    const segments = extractMessageSegments(
      "아래는 **E2E 테스트 최종 결과 화면**입니다.\n\n![관리자 E2E 최종 결과](sandbox:/tmp/admin-e2e-final-result.png)"
    );
    expect(segments.filter((s) => s.type === "image")).toEqual([
      { type: "image", path: "/tmp/admin-e2e-final-result.png" },
    ]);
    // The "](" must not survive into the rendered text either.
    expect(segments.every((s) => s.type !== "text" || !s.value.includes("]("))).toBe(true);
  });

  it("handles markdown image syntax without a scheme", () => {
    const segments = extractMessageSegments("![shot](docs/evidence/a.png) 입니다");
    expect(segments).toEqual([
      { type: "image", path: "docs/evidence/a.png" },
      { type: "text", value: " 입니다" },
    ]);
  });

  it("returns the whole message as one text segment when there's no image", () => {
    const segments = extractMessageSegments("작업을 완료했습니다. 파일: `README.md`");
    expect(segments).toEqual([{ type: "text", value: "작업을 완료했습니다. 파일: `README.md`" }]);
  });

  it("does not match non-image extensions", () => {
    const segments = extractMessageSegments("커밋: `apps/api/src/index.ts`");
    expect(segments.every((s) => s.type === "text")).toBe(true);
  });
});

describe("html preview references", () => {
  it("extracts an html path out of a leaked tool-call blob", () => {
    // Verbatim shape of what an agent put in the message body.
    const segments = extractMessageSegments(
      'visualize{"path":"/ws/frontend/test-results/design-previews/e2e-tab-design-proposal.html","mode":"wide","title":"E2E 테스트 탭 추천 디자인"}'
    );
    expect(segments.filter((s) => s.type === "html")).toEqual([
      { type: "html", path: "/ws/frontend/test-results/design-previews/e2e-tab-design-proposal.html" },
    ]);
  });

  it("extracts an html path from a markdown link", () => {
    const segments = extractMessageSegments("시안은 [여기](docs/preview.html) 입니다");
    expect(segments.filter((s) => s.type === "html")).toEqual([
      { type: "html", path: "docs/preview.html" },
    ]);
  });

  it("leaves incidental html file mentions as plain text", () => {
    // Agents backtick or mention every file they touch; embedding a preview
    // for each of those would be noise, so only deliberate forms count.
    for (const content of ["수정했습니다: `src/index.html`", "src/index.html 을 고쳤습니다"]) {
      expect(extractMessageSegments(content).every((s) => s.type === "text")).toBe(true);
    }
  });

  it("still classifies a quoted image path as an image, not html", () => {
    const segments = extractMessageSegments('{"path":"/tmp/shot.png"}');
    expect(segments.filter((s) => s.type !== "text")).toEqual([
      { type: "image", path: "/tmp/shot.png" },
    ]);
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

describe("classifyReferencePath", () => {
  it("classifies image and html link targets, stripping Codex's sandbox: prefix", () => {
    expect(classifyReferencePath("sandbox:/tmp/shot.png")).toEqual({ type: "image", path: "/tmp/shot.png" });
    expect(classifyReferencePath("docs/proposal.html")).toEqual({ type: "html", path: "docs/proposal.html" });
  });

  it("returns null for an ordinary link", () => {
    expect(classifyReferencePath("https://github.com/openai/codex/pull/1")).toBeNull();
    expect(classifyReferencePath("src/index.ts")).toBeNull();
  });
});
