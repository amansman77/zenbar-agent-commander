import os

os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")

from app.pr_info import _diff_from_files, find_all_pr_or_mr_urls, find_latest_pr_or_mr_url


def test_finds_a_github_pr_url():
    texts = ["작업을 시작합니다.", "완료했습니다. PR: https://github.com/yna-team/ohso/pull/161"]
    assert find_latest_pr_or_mr_url(texts) == "https://github.com/yna-team/ohso/pull/161"


def test_finds_a_self_hosted_gitlab_mr_url():
    texts = [
        "완료했습니다. MR: https://gitlab.inoberry.co.kr:4431/project/sqlgen/sqlgen-ai-webapp/-/merge_requests/2037"
    ]
    assert (
        find_latest_pr_or_mr_url(texts)
        == "https://gitlab.inoberry.co.kr:4431/project/sqlgen/sqlgen-ai-webapp/-/merge_requests/2037"
    )


def test_returns_none_when_no_url_is_present():
    assert find_latest_pr_or_mr_url(["아직 진행 중입니다.", "거의 다 됐습니다."]) is None


def test_prefers_the_most_recently_mentioned_url():
    # Regression: a pipeline or a retried task can mention more than one
    # PR/MR across its messages (e.g. a stale link from an earlier attempt,
    # or a followup that opened a fresh one) -- the latest mention should
    # win, matching what's actually current.
    texts = [
        "완료했습니다. PR: https://github.com/yna-team/ohso/pull/100",
        "다시 시도했습니다. PR: https://github.com/yna-team/ohso/pull/101",
    ]
    assert find_latest_pr_or_mr_url(texts) == "https://github.com/yna-team/ohso/pull/101"


def test_prefers_the_latest_url_even_across_mixed_platforms():
    texts = [
        "MR: https://gitlab.inoberry.co.kr:4431/project/sqlgen/sqlgen-ai-webapp/-/merge_requests/1",
        "PR: https://github.com/yna-team/ohso/pull/2",
    ]
    assert find_latest_pr_or_mr_url(texts) == "https://github.com/yna-team/ohso/pull/2"


def test_ignores_unrelated_urls():
    texts = ["참고: https://github.com/yna-team/ohso/issues/91 본문을 확인하세요."]
    assert find_latest_pr_or_mr_url(texts) is None


def test_find_all_returns_every_distinct_url_most_recent_first():
    # A longer conversation (retries, several follow-ups) can genuinely
    # have opened more than one PR/MR -- all of them should show up, not
    # just the latest.
    texts = [
        "완료했습니다. PR: https://github.com/yna-team/ohso/pull/100",
        "MR: https://gitlab.inoberry.co.kr:4431/project/sqlgen/sqlgen-ai-webapp/-/merge_requests/1",
        "다시 시도했습니다. PR: https://github.com/yna-team/ohso/pull/101",
    ]
    assert find_all_pr_or_mr_urls(texts) == [
        "https://github.com/yna-team/ohso/pull/101",
        "https://gitlab.inoberry.co.kr:4431/project/sqlgen/sqlgen-ai-webapp/-/merge_requests/1",
        "https://github.com/yna-team/ohso/pull/100",
    ]


def test_find_all_dedupes_a_url_mentioned_more_than_once():
    texts = [
        "PR: https://github.com/yna-team/ohso/pull/100",
        "여전히 열려있습니다: https://github.com/yna-team/ohso/pull/100",
    ]
    assert find_all_pr_or_mr_urls(texts) == ["https://github.com/yna-team/ohso/pull/100"]


def test_find_all_returns_empty_list_when_no_url_is_present():
    assert find_all_pr_or_mr_urls(["아직 진행 중입니다."]) == []


def test_diff_from_files_synthesizes_the_git_diff_header():
    # Regression: hit for real -- both GitHub's PR files API and GitLab's MR
    # changes API return only the hunk body ("@@ ... @@" lines), not a
    # "diff --git a/... b/..." header. The frontend's diff parser
    # (parseDiffFiles) splits files on that header line, so without it the
    # whole raw_diff would render as one unlabeled blob instead of being
    # split per file.
    diff = _diff_from_files([("app/foo.py", "@@ -1,1 +1,1 @@\n-old\n+new")])

    assert diff.files_changed == ["app/foo.py"]
    assert diff.raw_diff is not None
    assert diff.raw_diff.startswith("diff --git a/app/foo.py b/app/foo.py\n")
    assert "@@ -1,1 +1,1 @@" in diff.raw_diff


def test_diff_from_files_lists_binary_files_without_a_patch():
    # GitHub/GitLab both omit patch/diff content for binary or very large
    # files -- still worth listing as a changed file, just with nothing to
    # render for it.
    diff = _diff_from_files([("docs/evidence/screenshot.png", None)])

    assert diff.files_changed == ["docs/evidence/screenshot.png"]
    assert diff.raw_diff is None


def test_diff_from_files_returns_empty_diff_for_no_files():
    diff = _diff_from_files([])
    assert diff.files_changed == []
    assert diff.raw_diff is None
