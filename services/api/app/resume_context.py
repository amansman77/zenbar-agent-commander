"""Builds the prompt that a replacement runtime session starts from.

When a follow-up finds the runtime session dead, Zenbar starts a fresh one.
That session has no memory of the thread, and the naive restart re-sent the
task's *original* prompt -- which, for a task that began "스테이지에 배포해줘",
silently started deploying again while the user was asking about something
else entirely. The agent said it had "mistaken the task metadata's deployment
wording for a real user request", which is exactly what had happened.

So the rules this file encodes:

- What the agent is asked to *do* is the message the user just sent, nothing
  else. The original request appears only as background, explicitly labelled
  as history, because re-running it is the failure this replaces.
- The recent transcript is replayed verbatim so the agent can pick up
  references ("that design proposal") that the summary would flatten away.
- The summary is assembled from facts Zenbar already has rather than by asking
  a model to write one: a control plane that calls an LLM to restart a session
  is slower, can fail, and would need its own error path.
"""

from __future__ import annotations

from dataclasses import dataclass

# Enough for the agent to resolve "that one" / "the second option" without
# turning the restart prompt into a transcript dump.
RECENT_MESSAGE_LIMIT = 3


@dataclass(frozen=True)
class ResumeMessage:
    role: str
    content: str


def _role_label(role: str) -> str:
    return "사용자" if role == "user" else "어시스턴트"


def _truncate(text: str, limit: int = 2000) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + " …(이하 생략)"


def build_resume_prompt(
    *,
    original_prompt: str,
    recent_messages: list[ResumeMessage],
    new_message: str,
) -> str:
    """Assembles the first input for a session that replaces a dead one."""
    sections: list[str] = [
        "[안내] 이전 세션이 만료되어 새 세션으로 이어집니다. "
        "아래 '이전 맥락'과 '최근 대화'는 참고용 이력입니다. "
        "지금 수행할 작업은 맨 아래 '현재 요청' 하나뿐이며, "
        "이전 요청을 다시 실행하지 마세요.",
        "",
        "[이전 맥락]",
        f"- 이 작업의 최초 요청: {_truncate(original_prompt, 500)}",
    ]

    if recent_messages:
        sections.append(f"- 직전 대화 {len(recent_messages)}건을 아래에 옮깁니다.")
        sections.append("")
        sections.append("[최근 대화]")
        for message in recent_messages:
            sections.append(f"{_role_label(message.role)}: {_truncate(message.content)}")
    else:
        sections.append("- 남아 있는 이전 대화 기록이 없습니다.")

    sections.extend(["", "[현재 요청]", new_message.strip()])
    return "\n".join(sections)
