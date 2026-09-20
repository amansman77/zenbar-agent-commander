from app.resume_context import ResumeMessage, build_resume_prompt


def test_new_message_is_the_only_instruction():
    # The bug this replaces: the restart re-sent the original prompt, so a task
    # that began "스테이지에 배포해줘" started deploying again while the user was
    # asking about something else. The original request may appear only as
    # labelled history, never as the thing to do.
    prompt = build_resume_prompt(
        original_prompt="sqlgen-ai-webapp, agoraai, agorax-worker 를 스테이지에 배포해줘.",
        recent_messages=[ResumeMessage(role="user", content="디자인 시안 보여줘")],
        new_message="두 번째 시안으로 진행해줘",
    )

    assert prompt.rstrip().endswith("두 번째 시안으로 진행해줘")
    assert "[현재 요청]" in prompt
    assert "이전 요청을 다시 실행하지 마세요" in prompt
    # Present, but under the history heading rather than the instruction one.
    body, _, current = prompt.partition("[현재 요청]")
    assert "스테이지에 배포해줘" in body
    assert "스테이지에 배포해줘" not in current


def test_recent_messages_are_replayed_in_order_with_speaker_labels():
    prompt = build_resume_prompt(
        original_prompt="원래 요청",
        recent_messages=[
            ResumeMessage(role="user", content="첫 번째"),
            ResumeMessage(role="assistant", content="두 번째"),
            ResumeMessage(role="user", content="세 번째"),
        ],
        new_message="이어서 해줘",
    )

    assert prompt.index("첫 번째") < prompt.index("두 번째") < prompt.index("세 번째")
    assert "사용자: 첫 번째" in prompt
    assert "어시스턴트: 두 번째" in prompt


def test_handles_a_conversation_with_no_recorded_messages():
    prompt = build_resume_prompt(
        original_prompt="원래 요청",
        recent_messages=[],
        new_message="계속",
    )

    assert "남아 있는 이전 대화 기록이 없습니다" in prompt
    assert prompt.rstrip().endswith("계속")


def test_long_messages_are_truncated_so_the_prompt_stays_bounded():
    prompt = build_resume_prompt(
        original_prompt="원래 요청",
        recent_messages=[ResumeMessage(role="assistant", content="가" * 5000)],
        new_message="계속",
    )

    assert "이하 생략" in prompt
    assert len(prompt) < 4000
