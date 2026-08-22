from __future__ import annotations

import subprocess
from concurrent.futures import ThreadPoolExecutor

from .schemas import TaskDiff


def _run_git(working_directory: str, args: list[str], check: bool = True, timeout: float = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", working_directory, "-c", "core.quotepath=false", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=check,
    )


def summarize_stderr_for_failure(stderr_text: str) -> str | None:
    """Pick the most useful single line out of a CLI's captured stderr tail
    for folding into a failure event's user-facing `message`.

    Hit for real: a Grok turn failed with the generic "Grok exited with code
    1" and "(Grok produced no text response.)" -- the actual reason (a free
    plan usage-limit error) was captured correctly in the `failed` event's
    `payload.stderr`, but the frontend's failure banner only ever reads the
    event `message`, never `payload`, so the real cause was invisible to the
    user. CLIs conventionally put their own summary/error line last, so take
    the last non-blank line and cap it so it doesn't blow out a chat bubble.
    """
    for line in reversed(stderr_text.strip().splitlines()):
        line = line.strip()
        if line:
            return line[:300]
    return None


def compute_workspace_diff(working_directory: str, default_branch: str, engine_label: str) -> TaskDiff:
    """Uncommitted-changes diff for a CLI-based engine's workspace.

    Shared by adapters that spawn a headless CLI per turn (Antigravity, Grok)
    rather than talking to a persistent server that reports its own diff --
    for those, git is the only source of truth, so this is identical for
    each of them by construction. Only `engine_label` varies, for the
    "no changes" message.
    """
    try:
        result = _run_git(working_directory, ["diff", default_branch], timeout=15)
    except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return TaskDiff()

    diff = result.stdout
    files: list[str] = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                files.append(parts[3].removeprefix("b/"))

    # `git diff` never reports untracked files, tracked-or-not: a file the
    # agent just created (and hasn't `git add`ed) is invisible to it no
    # matter what ref it's compared against. Verified against a real Grok
    # turn that created a new file end-to-end -- the diff came back empty
    # despite the file genuinely existing, which is what surfaced this.
    # Mirrors the same technique TaskOrchestrator._compute_workspace_diff
    # already uses for the Codex path (git diff --no-index against
    # /dev/null, per untracked file).
    try:
        untracked_out = _run_git(working_directory, ["ls-files", "--others", "--exclude-standard"]).stdout
    except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        untracked_out = ""
    untracked_paths = [line.strip() for line in untracked_out.splitlines() if line.strip()]
    files.extend(untracked_paths)

    def _diff_for_untracked(rel_path: str) -> str | None:
        try:
            # git diff --no-index exits 1 when the files differ (the normal
            # case here) and 0 only if they're identical, which can't happen
            # against /dev/null -- so this call must not raise on exit 1.
            result = _run_git(working_directory, ["diff", "--no-index", "/dev/null", rel_path], check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode <= 1 and result.stdout.strip():
            return result.stdout.strip()
        return None

    # Each untracked file is its own git subprocess spawn (no way to batch
    # `--no-index` across multiple pairs) -- for a task that created many
    # new files, running them one at a time added up. ThreadPoolExecutor.map
    # keeps the same file order the sequential loop had, since raw_diff's
    # file order is expected to line up with files_changed.
    untracked_diffs: list[str] = []
    if untracked_paths:
        with ThreadPoolExecutor(max_workers=min(8, len(untracked_paths))) as pool:
            untracked_diffs = [diff for diff in pool.map(_diff_for_untracked, untracked_paths) if diff]

    files = list(dict.fromkeys(files))
    raw_diff = "\n".join(filter(None, [diff.strip(), *untracked_diffs])) or None
    if not files and not raw_diff:
        return TaskDiff()

    summary = f"Updated {len(files)} file(s) in the Task Workspace." if files else f"{engine_label} produced no file changes."
    return TaskDiff(files_changed=files, summary=summary, raw_diff=raw_diff)
