// Detects image file references inside an agent's plain-text message.
//
// Agents don't write markdown image syntax (`![]()`) for the screenshots
// they produce -- they just mention the path in prose, usually backtick-
// quoted, e.g. "증거 이미지: `docs/evidence/issue-86/foo.png`". Sometimes
// it's a real URL instead (a GitHub raw link) rather than a local path.
// Splitting the message around these references is what lets the chat
// bubble render an actual thumbnail in place of the path text.

export type MessageSegment =
  | { type: "text"; value: string }
  | { type: "image"; path: string };

const IMAGE_EXTENSION = "png|jpe?g|gif|webp|svg";

// Group 1: a backtick-quoted path/URL (the common case in real agent
// output) -- the closing backtick is an unambiguous boundary.
// Group 2: the same, bare in running text -- \b right after the extension
// stops the match there, so trailing punctuation ("...foo.png.", "(foo.png)")
// is naturally excluded rather than needing separate stripping.
const IMAGE_REFERENCE_RE = new RegExp(
  "`([^`\\s]+\\.(?:" + IMAGE_EXTENSION + "))`" + "|" + "(\\S+\\.(?:" + IMAGE_EXTENSION + ")\\b)",
  "gi"
);

export function extractImageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(IMAGE_REFERENCE_RE)) {
    const path = match[1] ?? match[2];
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
