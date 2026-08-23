"""In-memory RuntimeAdapter used by the tests and ZENBAR_RUNTIME_MODE=mock.

Runs a task to completion synchronously without touching a real engine, which
is what lets the API tests exercise the whole task lifecycle.
"""

from __future__ import annotations

import asyncio

from collections.abc import AsyncIterator

from ..schemas import (
    RuntimeEvent,
    RuntimeSession,
    RuntimeSkill,
    RuntimeStartRequest,
    RuntimeUsageInfo,
    TaskDiff,
)
from .base import RuntimeAdapter

class MockRuntimeAdapter(RuntimeAdapter):
    stream_in_background = False

    def __init__(self) -> None:
        self._events: dict[str, list[RuntimeEvent]] = {}
        self._diffs: dict[str, TaskDiff] = {}
        self._requests: dict[str, RuntimeStartRequest] = {}

    async def list_collaboration_modes(self) -> list[str] | None:
        return ["default", "plan"]

    async def list_models(self) -> list[str] | None:
        return ["GPT-5.4", "GPT-5.3-Codex"]

    async def list_skills(self) -> list[RuntimeSkill] | None:
        return None

    async def get_usage(self) -> RuntimeUsageInfo | None:
        return None

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        session_id = f"mock-{request.task_id}"
        self._requests[session_id] = request
        if request.execution_mode == "plan":
            self._events[session_id] = [
                RuntimeEvent(type="agent_status", message="Analyzing repository in plan mode"),
                RuntimeEvent(
                    type="plan_updated",
                    message="Plan updated with 2 step(s)",
                    payload={
                        "explanation": "Produce a safe implementation sequence.",
                        "plan": [
                            {"step": "Inspect sitemap generation", "status": "in_progress"},
                            {"step": "Add regression test coverage", "status": "pending"},
                        ],
                    },
                ),
                RuntimeEvent(type="plan_delta", message="Inspect sitemap generation"),
                RuntimeEvent(type="completed", message="Plan completed"),
            ]
            self._diffs[session_id] = TaskDiff()
        else:
            self._events[session_id] = [
                RuntimeEvent(type="agent_status", message="Analyzing repository"),
                RuntimeEvent(type="file_changed", message="app/sitemap.ts", payload={"file": "app/sitemap.ts"}),
                RuntimeEvent(type="diff_generated", message="Patch ready", payload={"files_changed": ["app/sitemap.ts"]}),
                RuntimeEvent(
                    type="result_approval_requested",
                    message="Waiting for result approval",
                    payload={"request_id": "mock-approval", "method": "item/fileChange/requestApproval"},
                ),
            ]
            self._diffs[session_id] = TaskDiff(
                files_changed=["app/sitemap.ts"],
                summary="Added canonical tag fallback",
                raw_diff="diff --git a/app/sitemap.ts b/app/sitemap.ts\n+ canonical fallback",
            )
        return RuntimeSession(session_id=session_id, effective_model=request.model)

    async def stop_task(self, session_id: str) -> None:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        self._events.setdefault(session_id, []).append(RuntimeEvent(type="stopped", message="Task stopped"))

    async def approve_task(self, session_id: str) -> None:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        self._events.setdefault(session_id, []).extend(
            [
                RuntimeEvent(
                    type="result_approval_granted",
                    message="Result approval granted",
                    payload={"request_id": "mock-approval"},
                ),
                RuntimeEvent(type="agent_status", message="Running tests"),
                RuntimeEvent(type="test_result", message="All tests passed"),
                RuntimeEvent(type="completed", message="Accepted result completed"),
            ]
        )

    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        self._events.setdefault(session_id, []).extend(
            [
                RuntimeEvent(
                    type="user_input_submitted",
                    message="User input submitted",
                    payload={"request_id": request_id, "answers": answers},
                ),
                RuntimeEvent(type="agent_status", message="Continuing after user input"),
            ]
        )

    async def retry_task(self, session_id: str) -> RuntimeSession:
        request = self._requests.get(session_id)
        if request is None:
            task_id = session_id.replace("mock-", "")
            request = RuntimeStartRequest(
                task_id=task_id,
                title="retry",
                prompt="retry",
                model="GPT-5.4",
                reasoning_effort="medium",
                repo_path="/srv/repos/demo",
                working_directory="/srv/repos/demo",
                default_branch="main",
                execution_mode="execute",
                workspace_type="branch",
                workspace_ref=f"task/retry-{task_id[:4]}",
            )
        return await self.start_task(request)

    async def followup_task(
        self, session_id: str, message: str, selected_skill: str | None = None, model: str | None = None
    ) -> RuntimeSession:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        request = self._requests.get(session_id)
        if request is None:
            raise RuntimeError("Follow-up unavailable because original task request is missing")
        if model is not None:
            request.model = model
        self._events.setdefault(session_id, []).extend(
            [
                RuntimeEvent(type="agent_status", message="Follow-up turn started"),
                RuntimeEvent(type="command_executed", message="updated requested changes"),
                RuntimeEvent(
                    type="agent_status",
                    message="Applied follow-up changes",
                    payload={"role": "assistant", "content": "Applied requested follow-up changes."},
                ),
                # A follow-up's result needs approval just like the initial
                # turn (zenbar's result-approval step is baked into every
                # turn's prompt, not a one-time thing) -- matches
                # start_task's own event sequence below.
                RuntimeEvent(
                    type="result_approval_requested",
                    message="Waiting for result approval",
                    payload={"request_id": "mock-approval", "method": "item/fileChange/requestApproval"},
                ),
            ]
        )
        return RuntimeSession(session_id=session_id, effective_model=request.model)

    async def get_diff(self, session_id: str) -> TaskDiff:
        if session_id not in self._diffs:
            raise RuntimeError("Unknown Codex App Server session")
        return self._diffs[session_id]

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        events = self._events.get(session_id, [])
        while events:
            event = events.pop(0)
            await asyncio.sleep(0.01)
            yield event
