from __future__ import annotations

import re
import subprocess
import urllib.parse
from dataclasses import dataclass

import httpx

from .schemas import TaskDiff


@dataclass
class PrInfo:
    platform: str  # "github" | "gitlab"
    number: int
    title: str
    description: str | None
    state: str  # normalized: "open" | "merged" | "closed"
    url: str
    source_branch: str | None
    target_branch: str | None
    author: str | None
    merged_at: str | None


# GitHub PRs are always github.com; GitLab MRs are almost always self-hosted
# (as is the one this was built against), so its host is a capture group,
# not hardcoded -- `_credential_token` looks up whatever git already has
# stored for that specific host.
_GITHUB_PR_RE = re.compile(r"https://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)")
_GITLAB_MR_RE = re.compile(r"https://([^/\s]+)/(.+?)/-/merge_requests/(\d+)")


def find_all_pr_or_mr_urls(texts: list[str]) -> list[str]:
    """Scan message texts (oldest first) for every distinct PR/MR URL
    mentioned, returning them most-recently-mentioned first -- a longer
    conversation (retries, several follow-ups each opening their own PR/MR)
    can genuinely have more than one. A URL mentioned more than once is
    listed once, at its most recent mention's position.
    """
    found: list[str] = []
    for text in texts:
        for regex in (_GITHUB_PR_RE, _GITLAB_MR_RE):
            for match in regex.finditer(text):
                url = match.group(0)
                if url in found:
                    found.remove(url)
                found.append(url)
    return list(reversed(found))


def find_latest_pr_or_mr_url(texts: list[str]) -> str | None:
    """The single most recently mentioned PR/MR URL -- an agent's final
    summary is where this normally shows up ("PR: <url>" / "MR: <url>"),
    and later mentions should win over earlier ones (e.g. a stale link from
    an early plan). Used where only one, authoritative URL makes sense
    (the diff tab's "which PR/MR's diff do I show" choice) -- see
    find_all_pr_or_mr_urls for the "list every one" case (the info cards).
    """
    urls = find_all_pr_or_mr_urls(texts)
    return urls[0] if urls else None


def _credential_token(host: str) -> str | None:
    """Reuse whatever credential git itself would use for this host -- same
    approach as github_pr.py's _github_token (avoids introducing a second
    token to configure/rotate), generalized to any host so it also covers
    self-hosted GitLab instances.
    """
    try:
        completed = subprocess.run(
            ["git", "credential", "fill"],
            input=f"protocol=https\nhost={host}\n\n",
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


async def fetch_pr_or_mr_info(url: str) -> PrInfo | None:
    github_match = _GITHUB_PR_RE.match(url)
    if github_match:
        owner, repo, number_str = github_match.groups()
        return await _fetch_github_pr(owner, repo, number_str)
    gitlab_match = _GITLAB_MR_RE.match(url)
    if gitlab_match:
        host, project_path, iid_str = gitlab_match.groups()
        return await _fetch_gitlab_mr(host, project_path, iid_str)
    return None


async def _fetch_github_pr(owner: str, repo: str, number_str: str) -> PrInfo | None:
    token = _credential_token("github.com")
    if not token:
        return None
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}/pulls/{number_str}", headers=headers)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    data = resp.json()
    state = "merged" if data.get("merged_at") else data.get("state") or "unknown"
    return PrInfo(
        platform="github",
        number=data.get("number"),
        title=data.get("title") or "",
        description=data.get("body"),
        state=state,
        url=data.get("html_url") or "",
        source_branch=(data.get("head") or {}).get("ref"),
        target_branch=(data.get("base") or {}).get("ref"),
        author=(data.get("user") or {}).get("login"),
        merged_at=data.get("merged_at"),
    )


async def _fetch_gitlab_mr(host: str, project_path: str, iid_str: str) -> PrInfo | None:
    token = _credential_token(host)
    if not token:
        return None
    encoded_path = urllib.parse.quote(project_path, safe="")
    headers = {"PRIVATE-TOKEN": token}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://{host}/api/v4/projects/{encoded_path}/merge_requests/{iid_str}", headers=headers
            )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    data = resp.json()
    state = data.get("state") or "unknown"
    if state == "opened":
        state = "open"
    return PrInfo(
        platform="gitlab",
        number=data.get("iid"),
        title=data.get("title") or "",
        description=data.get("description"),
        state=state,
        url=data.get("web_url") or "",
        source_branch=data.get("source_branch"),
        target_branch=data.get("target_branch"),
        author=(data.get("author") or {}).get("username"),
        merged_at=data.get("merged_at"),
    )


def _diff_from_files(files: list[tuple[str, str | None]]) -> TaskDiff:
    file_names: list[str] = []
    diff_parts: list[str] = []
    for filename, patch in files:
        file_names.append(filename)
        # Both APIs return only the hunk body ("@@ ... @@" lines), not a
        # "diff --git a/... b/..." header -- the frontend's diff parser
        # (parseDiffFiles) splits files on that header line, so it has to
        # be synthesized here. Binary/very large files come back with no
        # patch/diff content at all (GitHub and GitLab both do this) --
        # still listed in files_changed, just with nothing to render.
        if patch:
            diff_parts.append(f"diff --git a/{filename} b/{filename}\n{patch}")
    if not file_names:
        return TaskDiff()
    summary = f"Updated {len(file_names)} file(s) in the pull/merge request."
    return TaskDiff(files_changed=file_names, summary=summary, raw_diff="\n".join(diff_parts) or None)


async def fetch_pr_or_mr_diff(url: str) -> TaskDiff | None:
    """The PR/MR's own diff, as reported by GitHub/GitLab -- the
    authoritative record of what actually changed, independent of the local
    task workspace's current state (which, for anything already committed,
    shows nothing -- see TaskOrchestrator.refresh_diff's own docstring).
    """
    github_match = _GITHUB_PR_RE.match(url)
    if github_match:
        owner, repo, number_str = github_match.groups()
        return await _fetch_github_pr_diff(owner, repo, number_str)
    gitlab_match = _GITLAB_MR_RE.match(url)
    if gitlab_match:
        host, project_path, iid_str = gitlab_match.groups()
        return await _fetch_gitlab_mr_diff(host, project_path, iid_str)
    return None


async def _fetch_github_pr_diff(owner: str, repo: str, number_str: str) -> TaskDiff | None:
    token = _credential_token("github.com")
    if not token:
        return None
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # per_page=100 covers the large majority of real PRs; beyond
            # that this silently shows only the first 100 files rather than
            # paginating -- an acceptable tradeoff for a "preview" card, not
            # exhaustively re-implementing GitHub's own PR files UI.
            resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/pulls/{number_str}/files",
                headers=headers,
                params={"per_page": 100},
            )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    files = resp.json()
    if not isinstance(files, list):
        return None
    return _diff_from_files([(f.get("filename"), f.get("patch")) for f in files if f.get("filename")])


async def _fetch_gitlab_mr_diff(host: str, project_path: str, iid_str: str) -> TaskDiff | None:
    token = _credential_token(host)
    if not token:
        return None
    encoded_path = urllib.parse.quote(project_path, safe="")
    headers = {"PRIVATE-TOKEN": token}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://{host}/api/v4/projects/{encoded_path}/merge_requests/{iid_str}/changes", headers=headers
            )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    changes = resp.json().get("changes")
    if not isinstance(changes, list):
        return None
    return _diff_from_files(
        [
            (path, c.get("diff"))
            for c in changes
            if (path := c.get("new_path") or c.get("old_path"))
        ]
    )
