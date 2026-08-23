"""The RuntimeAdapter interface every engine implements, and the pieces shared
by all of them.

An adapter turns Zenbar's task lifecycle calls (start/stop/approve/retry/
follow-up) into whatever the engine actually speaks, and turns the engine's
output back into a stream of RuntimeEvents. Implementations live in
app_server.py (Codex, over WebSocket), mock.py, and the CLI-backed adapters in
app/*_adapter.py.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from ..schemas import (
    RuntimeEvent,
    RuntimeSession,
    RuntimeSkill,
    RuntimeStartRequest,
    RuntimeUsageInfo,
    TaskDiff,
)

class RuntimeAdapter(ABC):
    stream_in_background = True

    @abstractmethod
    async def list_collaboration_modes(self) -> list[str] | None:
        raise NotImplementedError

    @abstractmethod
    async def list_models(self) -> list[str] | None:
        raise NotImplementedError

    @abstractmethod
    async def list_skills(self) -> list[RuntimeSkill] | None:
        raise NotImplementedError

    @abstractmethod
    async def get_usage(self) -> RuntimeUsageInfo | None:
        """Account-level rate-limit/quota status, independent of any task or
        session -- `None` for engines/CLIs with no way to report this."""
        raise NotImplementedError

    @abstractmethod
    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        raise NotImplementedError

    @abstractmethod
    async def stop_task(self, session_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    async def approve_task(self, session_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        raise NotImplementedError

    @abstractmethod
    async def retry_task(self, session_id: str) -> RuntimeSession:
        raise NotImplementedError

    @abstractmethod
    async def followup_task(
        self, session_id: str, message: str, selected_skill: str | None = None, model: str | None = None
    ) -> RuntimeSession:
        # model: switch the model for this and subsequent turns, keeping
        # the same session/workspace/history -- None means "keep whatever
        # this session is already using".
        raise NotImplementedError

    @abstractmethod
    async def get_diff(self, session_id: str) -> TaskDiff:
        raise NotImplementedError

    @abstractmethod
    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        raise NotImplementedError


def _prompt_with_workspace(request: RuntimeStartRequest) -> str:
    operation = (
        "Produce an implementation plan without modifying files or accepting final code changes."
        if request.execution_mode == "plan"
        else "Operate inside the current repository working directory."
    )
    skill_line = f"\nRequested skill: {request.selected_skill}" if request.selected_skill else ""
    # This used to unconditionally instruct execute-mode tasks to "commit,
    # push, and open a GitHub pull request" once done, regardless of what the
    # user's own prompt actually asked for. Removed at the user's explicit
    # request ("commit/PR 요청은 내가 명시적으로 할테니까 해당 프롬프트는
    # 제거해줘") after it caused two real problems: (1) it fired even for
    # purely informational requests with no code-change intent, pushing the
    # agent to manufacture a change just to have something to commit/PR
    # against; (2) it hardcoded "GitHub pull request", which doesn't hold for
    # GitLab-backed projects -- the agent adapted on its own by opening a
    # GitLab MR instead, using ad-hoc token-based push auth whose token then
    # ended up logged in plaintext in the task's event history. The user now
    # asks for commit/push/PR explicitly in the prompt itself when wanted.
    return (
        f"Task title: {request.title}\n"
        f"Task workspace: {request.workspace_ref}\n"
        f"Task working directory: {request.working_directory}\n"
        f"Default branch: {request.default_branch}\n\n"
        f"{request.prompt}{skill_line}\n\n"
        f"{operation} "
        "Human approval is required before the task result is accepted as final."
    )


def is_default_model_alias(model: str | None) -> bool:
    if not model:
        return False
    return model.strip().lower() in {"default", "runtime-default", "auto"}
