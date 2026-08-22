// Diff rendering: a colored raw diff, the per-file collapsible grouped view, and
// the PR/MR diff section shown on conversation PR cards.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  TaskDiff
} from "@zenbar/shared";
import { api } from "../api";
import { diffLineClass, parseDiffFiles } from "../lib/diff";
import type { DiffFileStatus } from "../lib/diff";

function ColoredDiff({ rawDiff }: { rawDiff: string }) {
  const lines = rawDiff.split("\n");
  return (
    <pre className="output-pre diff-pre">
      <code>
        {lines.map((line, index) => (
          <span key={`diff-${index}`} className={`diff-line ${diffLineClass(line)}`}>
            {line || " "}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function GroupedDiff({
  rawDiff,
  filesChanged,
  expanded,
  onToggle
}: {
  rawDiff: string;
  filesChanged: string[];
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  const parsed = useMemo(() => parseDiffFiles(rawDiff), [rawDiff]);
  const groups =
    parsed.length > 0
      ? parsed
      : filesChanged.map((file, index) => ({
          id: `${file}-${index}`,
          fileName: file,
          lines: [],
          additions: 0,
          deletions: 0,
          status: "modified" as const
        }));

  return (
    <div className="diff-groups">
      {groups.map((group) => {
        const isExpanded = Boolean(expanded[group.id]);
        const changeCount = group.additions + group.deletions;
        return (
          <section key={group.id} className="diff-group">
            <button type="button" className="diff-group-header" onClick={() => onToggle(group.id)} aria-expanded={isExpanded}>
              <span className="diff-group-header-name">
                <DiffStatusBadge status={group.status} />
                <span className="mono truncate">{group.fileName}</span>
              </span>
              <span className="diff-change-count">
                {changeCount} changes
              </span>
            </button>
            {isExpanded && group.lines.length > 0 ? <ColoredDiff rawDiff={group.lines.join("\n")} /> : null}
          </section>
        );
      })}
    </div>
  );
}

// git's own single-letter status convention (A/M/D/R), the same shorthand
// `git diff --name-status` and most git UIs use.
function DiffStatusBadge({ status }: { status: DiffFileStatus }) {
  const label = status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M";
  const title =
    status === "added" ? "Added" : status === "deleted" ? "Deleted" : status === "renamed" ? "Renamed" : "Modified";
  return (
    <span className={`diff-status-badge diff-status-${status}`} title={title} aria-label={title}>
      {label}
    </span>
  );
}

// A PR/MR card's own changed-file list, collapsed by default -- shown
// nested under that specific card so a conversation with several PR/MRs
// makes it obvious which files belong to which, instead of one flat file
// list below all the cards with no way to tell them apart.
//
// `diff` (from the pr-info list) never carries raw_diff -- that list is
// polled every 15s while a task is active, and raw_diff is where nearly
// all of a real diff's payload lives (measured live: 95KB of a 110KB
// response, for cards nobody had even expanded yet). Expanding a card
// fetches its full diff separately, on demand, via its own URL.
export function PrDiffSection({ conversationId, url, diff }: { conversationId: string; url: string; diff: TaskDiff | null }) {
  const [showFiles, setShowFiles] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fullDiffQuery = useQuery({
    queryKey: ["conv-pr-diff", conversationId, url],
    queryFn: () => api.getConversationPrDiff(conversationId, url),
    enabled: showFiles,
    staleTime: 60_000
  });

  if (!diff || diff.files_changed.length === 0) {
    return null;
  }

  const rawDiff = fullDiffQuery.data?.raw_diff ?? null;

  return (
    <div className="pr-info-card-diff">
      <button type="button" className="pr-info-card-diff-toggle" onClick={() => setShowFiles((prev) => !prev)}>
        {showFiles ? "변경 파일 접기" : `변경 파일 보기 (${diff.files_changed.length})`}
      </button>
      {showFiles ? (
        rawDiff ? (
          <GroupedDiff
            rawDiff={rawDiff}
            filesChanged={diff.files_changed}
            expanded={expanded}
            onToggle={(id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))}
          />
        ) : fullDiffQuery.isFetching ? (
          <p className="empty-state">불러오는 중...</p>
        ) : (
          <ul className="pr-info-card-diff-filelist">
            {diff.files_changed.map((file) => (
              <li key={file} className="mono">
                {file}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
