// Parses a unified diff into per-file entries with an added/modified/deleted/
// renamed status, and classifies single diff lines for syntax coloring.

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export type ParsedDiffFile = {
  id: string;
  fileName: string;
  lines: string[];
  additions: number;
  deletions: number;
  status: DiffFileStatus;
};

export function parseDiffFiles(rawDiff: string): ParsedDiffFile[] {
  const lines = rawDiff.split("\n");
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;

  const flushCurrent = () => {
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushCurrent();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const fileName = match?.[2] ?? line.replace("diff --git ", "");
      current = {
        id: `${fileName}-${files.length}`,
        fileName,
        lines: [line],
        additions: 0,
        deletions: 0,
        // Refined below from this file's own header lines (new file
        // mode/deleted file mode/rename from+to) when present -- "modified"
        // is the right default for the common case where none of those
        // appear at all.
        status: "modified"
      };
      continue;
    }
    if (!current) {
      current = {
        id: `raw-${files.length}`,
        fileName: `changes-${files.length + 1}`,
        lines: [],
        additions: 0,
        deletions: 0,
        status: "modified"
      };
    }
    current.lines.push(line);
    // Real `git diff` output carries these same header lines for its own
    // added/deleted/renamed files, so this applies equally whether rawDiff
    // came from a real workspace diff or a PR/MR's synthesized one
    // (pr_info.py's _diff_from_files emits the identical lines).
    if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from") || line.startsWith("rename to")) {
      current.status = "renamed";
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
  }

  flushCurrent();
  return files;
}

export function diffLineClass(line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "diff-line-meta";
  }
  if (line.startsWith("@@")) {
    return "diff-line-hunk";
  }
  if (line.startsWith("+")) {
    return "diff-line-add";
  }
  if (line.startsWith("-")) {
    return "diff-line-remove";
  }
  return "diff-line-neutral";
}
