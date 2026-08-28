"""Database access layer: every read and write of the ORM models, plus the
serializers that turn them into API schemas.

Split by what the functions are about, in dependency order:

    naming.py         slug / workspace branch name derivation
    projects.py       projects
    prompts.py        a project's saved prompts and pipelines
    tasks.py          tasks, runs, turns, status transitions
    events.py         the task event log and what it does to a task
    conversations.py  conversations and their messages
    serializers.py    ORM models -> API schemas

Routers and TaskOrchestrator import from the package (`from .repository
import get_task`), not from these submodules.
"""

from .naming import build_workspace_ref, slugify
from .projects import create_project, get_project, get_project_any, list_projects, soft_delete_project
from .prompts import (
    create_project_pipeline,
    create_project_prompt,
    delete_project_pipeline,
    delete_project_prompt,
    get_project_pipeline,
    get_project_prompt,
    list_project_pipelines,
    list_project_prompts,
    reorder_project_prompts,
    update_project_pipeline,
    update_project_prompt,
)
from .tasks import (
    can_approve,
    can_retry,
    can_stop,
    clear_runtime_session,
    create_run,
    create_task,
    create_turn,
    delete_task,
    get_latest_run,
    get_task,
    get_task_by_session_id,
    list_tasks,
    list_turns,
    session_id_for_task,
    set_task_pipeline_step,
    set_task_status,
    set_task_workspace,
    update_latest_run_status,
)
from .events import (
    add_approval,
    append_event,
    canonicalize_legacy_event_type,
    count_events,
    latest_event_at,
    list_events,
    map_status_from_event,
    normalize_event_type,
    replace_diff,
)
from .conversations import (
    add_conversation_message,
    add_conversation_message_for_task,
    count_conversations_by_project,
    create_conversation,
    delete_conversation,
    get_conversation,
    get_conversation_for_task,
    list_conversations,
    mark_conversation_read,
    set_conversation_task_id,
)
from .serializers import (
    serialize_conversation_detail,
    serialize_conversation_message,
    serialize_conversation_summary,
    serialize_diff,
    serialize_event,
    serialize_project,
    serialize_project_pipeline,
    serialize_project_prompt,
    serialize_run,
    serialize_task_detail,
    serialize_task_summary,
    serialize_turn,
)

__all__ = [
    "build_workspace_ref",
    "slugify",
    "create_project",
    "get_project",
    "get_project_any",
    "list_projects",
    "soft_delete_project",
    "create_project_pipeline",
    "create_project_prompt",
    "delete_project_pipeline",
    "delete_project_prompt",
    "get_project_pipeline",
    "get_project_prompt",
    "list_project_pipelines",
    "list_project_prompts",
    "reorder_project_prompts",
    "update_project_pipeline",
    "update_project_prompt",
    "can_approve",
    "can_retry",
    "can_stop",
    "clear_runtime_session",
    "create_run",
    "create_task",
    "create_turn",
    "delete_task",
    "get_latest_run",
    "get_task",
    "get_task_by_session_id",
    "list_tasks",
    "list_turns",
    "session_id_for_task",
    "set_task_pipeline_step",
    "set_task_status",
    "set_task_workspace",
    "update_latest_run_status",
    "add_approval",
    "append_event",
    "canonicalize_legacy_event_type",
    "count_events",
    "latest_event_at",
    "list_events",
    "map_status_from_event",
    "normalize_event_type",
    "replace_diff",
    "add_conversation_message",
    "add_conversation_message_for_task",
    "count_conversations_by_project",
    "create_conversation",
    "delete_conversation",
    "get_conversation",
    "get_conversation_for_task",
    "list_conversations",
    "mark_conversation_read",
    "set_conversation_task_id",
    "serialize_conversation_detail",
    "serialize_conversation_message",
    "serialize_conversation_summary",
    "serialize_diff",
    "serialize_event",
    "serialize_project",
    "serialize_project_pipeline",
    "serialize_project_prompt",
    "serialize_run",
    "serialize_task_detail",
    "serialize_task_summary",
    "serialize_turn",
]
