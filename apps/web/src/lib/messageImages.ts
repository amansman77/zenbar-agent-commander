// Detects image file references inside an agent's plain-text message.
//
// Agents reference the screenshots they produce three different ways, all of
// which appear in real output: markdown image syntax (`![alt](sandbox:/tmp/
// shot.png)` -- Codex does this), a backtick-quoted path in prose ("증거
// 이미지: `docs/evidence/issue-86/foo.png`"), or the path bare in running
// text. Sometimes it's a real URL (a GitHub raw link) rather than a local path.
// Splitting the message around these references is what lets the chat
// bubble render an actual thumbnail in place of the path text.

export type MessageSegment =
  | { type: "text"; value: string }
  | { type: "image"; path: string };

const IMAGE_EXTENSION = "png|jpe?g|gif|webp|svg";

// Group 1: real markdown image syntax. The header comment above used to say
// agents never write this -- they do now (a Codex screenshot arrived as
// "![관리자 E2E 최종 결과](sandbox:/tmp/shot.png)"), and it has to be tried
// first: the bare alternative's \S+ would otherwise start mid-syntax and
// capture "결과](sandbox:/tmp/shot.png", which is not a path anything can
// fetch. Matching the whole ![...](...) also keeps the "](" out of the text.
// Group 2: a backtick-quoted path/URL (the common case in real agent
// output) -- the closing backtick is an unambiguous boundary.
// Group 3: the same, bare in running text -- \b right after the extension
// stops the match there, so trailing punctuation ("...foo.png.", "(foo.png)")
// is naturally excluded rather than needing separate stripping.
const IMAGE_REFERENCE_RE = new RegExp(
  "!\\[[^\\]]*\\]\\(([^)\\s]+\\.(?:" + IMAGE_EXTENSION + "))\\)" +
    "|" +
    "`([^`\\s]+\\.(?:" + IMAGE_EXTENSION + "))`" +
    "|" +
    "(\\S+\\.(?:" + IMAGE_EXTENSION + ")\\b)",
  "gi"
);

// Codex writes files it produced as `sandbox:/tmp/shot.png`. That is not a
// scheme a browser can load, and the part after it is the real on-disk path
// the workspace-file endpoint already serves, so it is stripped here rather
// than being special-cased at every render site.
function normalizeImagePath(raw: string): string {
  return raw.replace(/^sandbox:/i, "");
}

export function extractImageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(IMAGE_REFERENCE_RE)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw) continue;
    const path = normalizeImagePath(raw);
    if (!path) continue;
    const matchStart = match.index ?? 0;
    const before = content.slice(lastIndex, matchStart);
    if (before) {
      segments.push({ type: "text", value: before });
    }
    segments.push({ type: "image", path });
    lastIndex = matchStart + match[0].length;
  }
  const rest = content.slice(lastIndex);
  if (rest) {
    segments.push({ type: "text", value: rest });
  }
  return segments;
}

export function isRemoteImageUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}
