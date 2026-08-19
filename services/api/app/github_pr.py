from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass

import httpx


GITHUB_API = "https://api.github.com"


@dataclass
class MergeResult:
    ok: bool
    message: str
    pr_number: int | None = None
    pr_url: str | None = None


def _run_git(cwd: str, args: list[str]) -> str:
    completed = subprocess.run(
        ["git", "-C", cwd, *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()


def parse_github_remote(remote_url: str) -> tuple[str, str] | None:
    """Extract (owner, repo) from an https or ssh GitHub remote URL."""
    cleaned = remote_url.strip()
    match = re.match(r"^(?:https://[^/]*github\.com/|git@github\.com:)([^/]+)/(.+?)(?:\.git)?/?$", cleaned)
    if not match:
        return None
    return match.group(1), match.group(2)


def _github_token(cwd: str) -> str | None:
    """Reuse whatever credential git itself would use for github.com.

    zenbar has no GitHub credentials of its own; the repos it drives are
    already cloned and pushed to by the user's git (osxkeychain helper on
    this machine), so asking git for the credential keeps auth in exactly
    one place instead of introducing a second token to configure/rotate.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", cwd, "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    for line in completed.stdout.splitlines():
        if line.startswith("password="):
            token = line.split("=", 1)[1].strip()
            return token or None
    return None


async def merge_pull_request_for_branch(
    workspace_path: str,
    branch: str,
    merge_method: str = "squash",
) -> MergeResult:
    """Find the open PR whose head is `branch` and merge it.

    Best-effort and non-raising: every failure path returns MergeResult(ok=False)
    with a human-readable reason, because this runs as a side effect of
    approving a task and must never turn a successful approval into an error.
    """
    try:
        origin = _run_git(workspace_path, ["remote", "get-url", "origin"])
    except RuntimeError as exc:
        return MergeResult(False, f"Could not read origin remote: {exc}")

    parsed = parse_github_remote(origin)
    if parsed is None:
        return MergeResult(False, f"Origin is not a GitHub remote: {origin}")
    owner, repo = parsed

    token = _github_token(workspace_path)
    if not token:
        return MergeResult(False, "No GitHub credential available for api.github.com")

    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            listed = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
                headers=headers,
                params={"head": f"{owner}:{branch}", "state": "open"},
            )
        except httpx.HTTPError as exc:
            return MergeResult(False, f"GitHub API request failed: {exc}")
        if listed.status_code != 200:
            return MergeResult(False, f"Could not list pull requests ({listed.status_code})")
        prs = listed.json()
        if not prs:
            return MergeResult(False, f"No open pull request found for branch '{branch}'")

        pr = prs[0]
        number = pr.get("number")
        url = pr.get("html_url")

        if pr.get("draft"):
            return MergeResult(False, f"Pull request #{number} is a draft", number, url)
        # mergeable_state is only populated on the single-PR endpoint, and
        # GitHub computes it asynchronously -- an unknown value here means
        # "not computed yet", not "conflicted", so only hard-fail on the
        # states that definitely can't merge.
        if pr.get("mergeable") is False:
            return MergeResult(False, f"Pull request #{number} has conflicts and cannot be merged", number, url)

        try:
            merged = await client.put(
                f"{GITHUB_API}/repos/{owner}/{repo}/pulls/{number}/merge",
                headers=headers,
                json={"merge_method": merge_method},
            )
        except httpx.HTTPError as exc:
            return MergeResult(False, f"Merge request failed: {exc}", number, url)

        if merged.status_code == 200:
            return MergeResult(True, f"Merged pull request #{number}", number, url)
        detail = ""
        try:
            detail = merged.json().get("message", "")
        except ValueError:
            pass
        return MergeResult(False, f"GitHub refused the merge ({merged.status_code}): {detail}", number, url)
