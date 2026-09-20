// Detects file references inside an agent's plain-text message -- images, and
// the self-contained HTML prototypes agents build as design proposals.
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
  | { type: "image"; path: string }
  | { type: "html"; path: string };

const IMAGE_EXTENSION = "png|jpe?g|gif|webp|svg";
// `html?` is "htm" with an optional "l", i.e. both spellings.
const HTML_EXTENSION = "html?";

// Branches are ordered most-delimited first, because several can start at the
// same character and the first listed wins there.
//
// Group 1: markdown [text](path) / ![alt](path). The header comment above used
// to say agents never write this -- they do now (a Codex screenshot arrived as
// "![관리자 E2E 최종 결과](sandbox:/tmp/shot.png)"), and it has to be tried
// first: the bare alternative's \S+ would otherwise start mid-syntax and
// capture "결과](sandbox:/tmp/shot.png", which is not a path anything can
// fetch. Matching the whole ![...](...) also keeps the "](" out of the text.
// Group 2: a backtick-quoted path/URL (the common case in real agent output)
// -- the closing backtick is an unambiguous boundary.
// Group 3: a double-quoted path. This is what carries an HTML preview in
// practice: agents leak a tool call into the message body, e.g.
// visualize{"path":"/…/proposal.html","mode":"wide"}, where nothing is
// whitespace-separated and only the quotes bound the path.
// Group 4: bare in running text -- \b right after the extension stops the
// match there, so trailing punctuation ("...foo.png.", "(foo.png)") is
// naturally excluded rather than needing separate stripping. Its character
// class excludes the delimiters the branches above own: a plain \S+ starts
// *earlier* than the quote in {"path":"/tmp/shot.png"} and, since the leftmost
// match wins regardless of branch order, it would swallow '{"path":"' into the
// path. Leading punctuation is dropped the same way trailing punctuation is.
//
// HTML is deliberately absent from the backtick and bare branches: agents
// backtick or mention every file they touch ("edited `src/index.html`"), and
// turning each of those into an embedded preview would be noise. A markdown
// link or a quoted path is a deliberate enough reference to act on.
const REFERENCE_RE = new RegExp(
  [
    "!?\\[[^\\]]*\\]\\(([^)\\s]+\\.(?:" + IMAGE_EXTENSION + "|" + HTML_EXTENSION + "))\\)",
    "`([^`\\s]+\\.(?:" + IMAGE_EXTENSION + "))`",
    '"([^"\\s]+\\.(?:' + IMAGE_EXTENSION + "|" + HTML_EXTENSION + '))"',
    "([^\\s\"'`()\\[\\]]+\\.(?:" + IMAGE_EXTENSION + ")\\b)",
  ].join("|"),
  "gi"
);

const HTML_PATH_RE = new RegExp("\\.(?:" + HTML_EXTENSION + ")$", "i");

// Codex writes files it produced as `sandbox:/tmp/shot.png`. That is not a
// scheme a browser can load, and the part after it is the real on-disk path
// the workspace-file endpoint already serves, so it is stripped here rather
// than being special-cased at every render site.
function normalizeReferencePath(raw: string): string {
  return raw.replace(/^sandbox:/i, "");
}

export function extractMessageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(REFERENCE_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!raw) continue;
    const path = normalizeReferencePath(raw);
    if (!path) continue;
    const matchStart = match.index ?? 0;
    const before = content.slice(lastIndex, matchStart);
    if (before) {
      segments.push({ type: "text", value: before });
    }
    segments.push({ type: HTML_PATH_RE.test(path) ? "html" : "image", path });
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
