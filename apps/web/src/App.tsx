// Root component: owns the selected project/task/conversation state, all
// top-level queries and mutations, and renders either the mobile screen stack or
// the desktop chat/workspace shell. Screens and components live alongside it in
// screens/, components/, hooks/ and lib/.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExecutionMode,
  ProjectSummary
} from "@zenbar/shared";
import { api } from "./api";
import { StatusBadge, UsageBadge } from "./components/Badges";
import { GroupedDiff } from "./components/DiffView";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { Modal } from "./components/Modal";
import { ProjectForm } from "./components/ProjectForm";
import { ProjectList } from "./components/ProjectList";
import { RunActionSheet } from "./components/RunActionSheet";
import { SessionComposer } from "./components/SessionComposer";
import { TaskForm } from "./components/TaskForm";
import { StructuredLogTab } from "./components/TaskTimeline";
import { useIsMobileBreakpoint } from "./hooks/useIsMobileBreakpoint";
import { useTaskCompletionNotifications } from "./hooks/useTaskCompletionNotifications";
import { useTaskStream } from "./hooks/useTaskStream";
import { CONVERSATION_GROUP_PREVIEW_COUNT, LAST_TASK_MODEL_KEY, USAGE_SUPPORTED_ENGINES, actor } from "./lib/constants";
import { formatRelativeTime } from "./lib/format";
import { TASK_NOTIFICATIONS_ENABLED_KEY, isNotificationSupported, loadTaskNotificationsEnabled } from "./lib/notifications";
import { extractLatestPlan } from "./lib/taskEvents";
import { defaultAnswers } from "./lib/taskQuestions";
import { getPrimaryAction, getRunResultLabel, getRunStatusLabel, getSecondaryActions, inferRunStatus } from "./lib/taskStatus";
import type { RunExecutionAction } from "./lib/taskStatus";
import { LAST_VIEW_KEY, loadLastView } from "./lib/viewState";
import type { DesktopView, MobileScreen } from "./lib/viewState";
import { ConversationDetailScreen } from "./screens/ConversationDetailScreen";
import { ConversationListScreen } from "./screens/ConversationListScreen";
import { ProjectPromptsModal, ProjectPromptsScreen } from "./screens/ProjectPromptsScreen";

export function App() {
  const queryClient = useQueryClient();
  const [lastView] = useState(loadLastView); // read once on mount, never re-read
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(lastView?.selectedProjectId ?? null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(lastView?.selectedTaskId ?? null);
  const [responseDraft, setResponseDraft] = useState<Record<string, string>>({});
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [promptsModalOpen, setPromptsModalOpen] = useState(false);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>(lastView?.mobileScreen ?? "conversations");
  // Desktop mirrors mobile's default: conversations are the primary surface.
  const [desktopView, setDesktopView] = useState<DesktopView>(lastView?.desktopView ?? "chat");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(lastView?.selectedConversationId ?? null);
  const [mobileDetailTab, setMobileDetailTab] = useState<"log" | "diff">("log");
  const [mobilePromptExpanded, setMobilePromptExpanded] = useState(false);
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Record<string, boolean>>({});
  const [planCopyState, setPlanCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [promptCopyState, setPromptCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [runActionModel, setRunActionModel] = useState("");
  const [runActionSheetOpen, setRunActionSheetOpen] = useState(false);
  const [pendingRunAction, setPendingRunAction] = useState<RunExecutionAction | null>(null);
  const [pendingExecutionMode, setPendingExecutionMode] = useState<ExecutionMode>("execute");
  const [commitMessage, setCommitMessage] = useState("Apply Task Workspace updates");
  const [gitActionMessage, setGitActionMessage] = useState<string | null>(null);
  const [followupDraft, setFollowupDraft] = useState("");
  const isMobile = useIsMobileBreakpoint();

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects
  });

  const runtimeProfilesQuery = useQuery({
    queryKey: ["runtime-profiles"],
    queryFn: api.listRuntimeProfiles,
    staleTime: 5 * 60 * 1000
  });

  const selectedProject = useMemo(
    () => projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null,
    [projectsQuery.data, selectedProjectId]
  );

  const tasksQuery = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () => api.listTasks(selectedProjectId!),
    enabled: Boolean(selectedProjectId)
  });

  const taskDetailQuery = useQuery({
    queryKey: ["task", selectedTaskId],
    queryFn: () => api.getTask(selectedTaskId!),
    enabled: Boolean(selectedTaskId)
  });

  const runtimeModelsQuery = useQuery({
    // Keyed and filtered on the selected task's own engine -- without this,
    // the query always fetched Codex's model list (the backend's default
    // when no `engine` is given) regardless of which engine the task
    // actually ran on, so the "Retry model" dropdown for an Antigravity or
    // Grok task silently offered Codex model ids instead.
    queryKey: ["runtime-models", selectedTaskId, taskDetailQuery.data?.engine],
    queryFn: () => api.listRuntimeModels(taskDetailQuery.data?.engine),
    enabled: Boolean(selectedTaskId),
    staleTime: 0
  });

  // Same account-level rate-limit badge as the conversation compose bar
  // (ConversationDetailScreen), but for this desktop Task Detail panel --
  // reported as a real gap: the compose bar's badge only shows while a
  // task's engine/model pickers are visible (i.e. before a task starts, or
  // in the chat view once it has), but this panel has no such indicator at
  // all, and it's the only place to inspect an already-running/completed
  // task without an editable model field.
  const taskDetailEnginesQuery = useQuery({
    queryKey: ["runtime-engines"],
    queryFn: () => api.listRuntimeEngines(),
    staleTime: 5 * 60 * 1000,
  });
  // Tasks stored with "" for engine (created before per-task engine
  // selection existed, or with none explicitly picked) mean "the default
  // engine", same convention the backend applies (see
  // TaskOrchestrator._adapter_for) -- `||`, not `??`, since "" is falsy but
  // not null/undefined. Caught live: the badge never appeared for exactly
  // these tasks.
  const taskDetailUsageEngine =
    taskDetailQuery.data?.engine || taskDetailEnginesQuery.data?.default_engine || null;
  const taskDetailUsageEngineSupported =
    taskDetailUsageEngine != null && USAGE_SUPPORTED_ENGINES.includes(taskDetailUsageEngine);
  const taskDetailUsageQuery = useQuery({
    queryKey: ["runtime-usage", "task-detail", taskDetailUsageEngine],
    queryFn: () => api.getRuntimeUsage(taskDetailUsageEngine!),
    enabled: taskDetailUsageEngineSupported,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const taskDetailUsageInfo = taskDetailUsageEngineSupported ? taskDetailUsageQuery.data?.usage ?? null : null;

  // Split into a small default fetch (command_executed/agent_status
  // excluded -- 98% of a long task's payload, measured live, for content
  // the timeline keeps collapsed by default anyway) and a full fetch only
  // triggered when the user actually taps "load full timeline" below.
  const [technicalEventsRequested, setTechnicalEventsRequested] = useState(false);
  useEffect(() => {
    setTechnicalEventsRequested(false);
  }, [selectedTaskId]);

  const taskEventsLeanQuery = useQuery({
    queryKey: ["task-events", selectedTaskId, "lean"],
    queryFn: () => api.getEventsLean(selectedTaskId!),
    enabled: Boolean(selectedTaskId),
    // SSE (useTaskStream below) already keeps this current in real time
    // while a task is open -- staleTime just stops focus/reconnect churn
    // (common on mobile: switching apps, wifi<->cellular handoff) from
    // redownloading it.
    staleTime: 60_000
  });
  const taskEventsFullQuery = useQuery({
    queryKey: ["task-events", selectedTaskId, "full"],
    queryFn: () => api.getEvents(selectedTaskId!),
    enabled: Boolean(selectedTaskId) && technicalEventsRequested,
    staleTime: 60_000
  });

  const taskDiffQuery = useQuery({
    queryKey: ["task-diff", selectedTaskId],
    queryFn: () => api.getDiff(selectedTaskId!),
    enabled: Boolean(selectedTaskId)
  });

  useTaskStream(selectedTaskId);

  const conversationsQuery = useQuery({
    queryKey: ["conversations", "preview", CONVERSATION_GROUP_PREVIEW_COUNT],
    queryFn: () => api.listConversations(CONVERSATION_GROUP_PREVIEW_COUNT),
    // Drives the whole conversations list + the notification watcher below,
    // so it can't stop polling entirely -- 8s (was 5s) is still prompt for
    // status changes while cutting request volume by ~40%.
    //
    // preview_count caps each project to its default-visible conversations
    // (server-side, still always including any conversation with an active
    // task regardless of position -- see list_conversations' own docstring
    // -- so the notification watcher below stays correct) -- measured
    // live, this cuts what was a 35KB/poll response down to ~7-8KB for the
    // account this was built against.
    refetchInterval: 8000,
  });
  const conversationCountsQuery = useQuery({
    queryKey: ["conversation-counts"],
    queryFn: api.getConversationCounts,
    // A tiny response (one number per project) -- doesn't need the same
    // 8s cadence as the list itself; it only backs the "더보기 (N)" label.
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const [taskNotificationsEnabled, setTaskNotificationsEnabled] = useState(loadTaskNotificationsEnabled);
  useTaskCompletionNotifications(conversationsQuery.data, taskNotificationsEnabled);

  const handleToggleTaskNotifications = async () => {
    if (!isNotificationSupported()) {
      return;
    }
    if (taskNotificationsEnabled) {
      setTaskNotificationsEnabled(false);
      window.localStorage.setItem(TASK_NOTIFICATIONS_ENABLED_KEY, "false");
      return;
    }
    // Browsers only honor a permission prompt triggered by a real user
    // gesture (this click), not one fired from an effect on mount -- so the
    // request has to happen here, not alongside the enabled-state read.
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission === "granted") {
      setTaskNotificationsEnabled(true);
      window.localStorage.setItem(TASK_NOTIFICATIONS_ENABLED_KEY, "true");
    } else {
      alert("브라우저 알림 권한이 차단되어 있어요. 브라우저 설정에서 이 사이트의 알림을 허용해주세요.");
    }
  };

  const createConversationMutation = useMutation({
    mutationFn: (projectId: string) => api.createConversation({ project_id: projectId }),
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setSelectedConversationId(conv.id);
      setMobileScreen("conversation-detail");
    },
  });

  const deleteConversationMutation = useMutation({
    mutationFn: api.deleteConversation,
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (selectedConversationId === deletedId) {
        setSelectedConversationId(null);
        setMobileScreen("conversations");
      }
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: api.createProject,
    onSuccess: (project) => {
      queryClient.setQueryData(["projects"], (previous: ProjectSummary[] | undefined) => {
        const next = previous ?? [];
        if (next.some((item) => item.id === project.id)) {
          return next;
        }
        return [project, ...next];
      });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setSelectedProjectId(project.id);
      setProjectModalOpen(false);
    }
  });

  const createTaskMutation = useMutation({
    mutationFn: api.createTask,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      setSelectedTaskId(task.id);
      setTaskModalOpen(false);
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: (_, projectId) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.removeQueries({ queryKey: ["tasks", projectId] });
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setSelectedTaskId(null);
      }
    }
  });

  const deleteTaskMutation = useMutation({
    mutationFn: api.deleteTask,
    onSuccess: (_, taskId) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", selectedProjectId] });
      queryClient.removeQueries({ queryKey: ["task", taskId] });
      queryClient.removeQueries({ queryKey: ["task-events", taskId] });
      queryClient.removeQueries({ queryKey: ["task-diff", taskId] });
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
      }
    }
  });

  const taskActionMutation = useMutation({
    mutationFn: async (input: { action: "approveTask" | "stopTask" | "retryTask"; taskId: string; model?: string }) => {
      if (input.action === "approveTask") {
        return api.approveTask(input.taskId, { actor });
      }
      if (input.action === "stopTask") {
        return api.stopTask(input.taskId, { actor });
      }
      return api.retryTask(input.taskId, { actor, model: input.model });
    },
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", task.id] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", task.id] });
    }
  });

  const respondMutation = useMutation({
    mutationFn: async (input: { taskId: string; answers: Record<string, string[]> }) =>
      api.respondTask(input.taskId, { actor, answers: input.answers }),
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", task.id] });
      setResponseDraft({});
    }
  });

  const followupMutation = useMutation({
    mutationFn: async (input: { sessionId: string; content: string }) =>
      api.createFollowupTurn(input.sessionId, { content: input.content }),
    onSuccess: (updatedTask) => {
      queryClient.setQueryData(["task", updatedTask.id], updatedTask);
      queryClient.invalidateQueries({ queryKey: ["tasks", updatedTask.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", updatedTask.id] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", updatedTask.id] });
      setFollowupDraft("");
      setMobileDetailTab("log");
    }
  });

  const workspaceCommitMutation = useMutation({
    mutationFn: (input: { taskId: string; message: string }) =>
      api.commitTaskWorkspace(input.taskId, { actor, message: input.message }),
    onSuccess: (result, input) => {
      setGitActionMessage(`Commit succeeded on ${result.branch ?? "branch"}`);
      queryClient.invalidateQueries({ queryKey: ["task-events", input.taskId] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", input.taskId] });
    }
  });

  const workspacePushMutation = useMutation({
    mutationFn: (input: { taskId: string }) =>
      api.pushTaskWorkspace(input.taskId, { actor, remote: "origin", set_upstream: true }),
    onSuccess: (result, input) => {
      setGitActionMessage(`Push succeeded: ${result.remote ?? "origin"}/${result.branch ?? ""}`);
      queryClient.invalidateQueries({ queryKey: ["task-events", input.taskId] });
    }
  });

  const task = taskDetailQuery.data ?? null;
  const events = technicalEventsRequested
    ? taskEventsFullQuery.data ?? []
    : taskEventsLeanQuery.data?.events ?? [];
  const hiddenTechnicalCount = technicalEventsRequested ? 0 : taskEventsLeanQuery.data?.hiddenTechnicalCount ?? 0;
  const diff = taskDiffQuery.data ?? task?.latest_diff;
  const runActionModelOptions = useMemo(() => {
    const ids = runtimeModelsQuery.data?.models.map((item) => item.id) ?? [];
    if (task?.model && !ids.includes(task.model)) {
      return [task.model, ...ids];
    }
    return ids;
  }, [runtimeModelsQuery.data?.models, task?.model]);
  const latestPlan = useMemo(() => extractLatestPlan(events), [events]);
  const planMarkdown = useMemo(() => {
    if (!latestPlan) {
      return "";
    }
    const sections: string[] = [];
    if (latestPlan.explanation) {
      sections.push(latestPlan.explanation);
    }
    if (latestPlan.steps.length > 0) {
      sections.push(
        ["## Plan steps", ...latestPlan.steps.map((step, idx) => `${idx + 1}. **${step.step}** - ${step.status}`)].join("\n")
      );
    }
    if (latestPlan.text) {
      sections.push(latestPlan.text);
    }
    return sections.join("\n\n");
  }, [latestPlan]);

  const handleDeleteProject = () => {
    if (!selectedProject) {
      return;
    }
    if (!window.confirm("Delete this project?")) {
      return;
    }
    deleteProjectMutation.mutate(selectedProject.id);
  };

  useEffect(() => {
    if (!task || task.status !== "waiting_user_input") {
      setResponseDraft({});
      return;
    }
    setResponseDraft((previous) => {
      const next = defaultAnswers(task.pending_questions);
      for (const question of task.pending_questions) {
        if (previous[question.id] !== undefined) {
          next[question.id] = previous[question.id];
        }
      }
      return next;
    });
  }, [task]);

  useEffect(() => {
    if (!task) {
      setRunActionModel("");
      setPendingRunAction(null);
      setRunActionSheetOpen(false);
      setCommitMessage("Apply Task Workspace updates");
      setGitActionMessage(null);
      return;
    }
    if (task.model && runActionModelOptions.includes(task.model)) {
      setRunActionModel(task.model);
    } else {
      setRunActionModel(runActionModelOptions[0] ?? "");
    }
    setPendingRunAction(null);
    setRunActionSheetOpen(false);
    setPendingExecutionMode(task.execution_mode ?? "execute");
    setCommitMessage(`Apply updates for ${task.title}`);
    setGitActionMessage(null);
    setFollowupDraft("");
  }, [task, runActionModelOptions]);

  useEffect(() => {
    if (!isMobile) {
      setMobileScreen("conversations");
    }
  }, [isMobile]);

  // Remember the current screen so a reloaded tab (e.g. iOS Safari
  // discarding a backgrounded tab) can reopen where the user left off
  // instead of always landing back on the root screen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        LAST_VIEW_KEY,
        JSON.stringify({ mobileScreen, desktopView, selectedConversationId, selectedProjectId, selectedTaskId })
      );
    } catch {
      // Quota exceeded or private-mode storage — losing "resume where you left off" isn't worth surfacing an error for.
    }
  }, [mobileScreen, desktopView, selectedConversationId, selectedProjectId, selectedTaskId]);

  const isHandlingPopState = useRef(false);

  // Push a history entry each time the mobile screen changes
  useEffect(() => {
    if (!isMobile) return;
    if (isHandlingPopState.current) {
      isHandlingPopState.current = false;
      return;
    }
    window.history.pushState({ mobileScreen }, "");
  }, [mobileScreen, isMobile]);

  // Handle browser back button on mobile
  useEffect(() => {
    if (!isMobile) return;
    const BACK_MAP: Partial<Record<MobileScreen, MobileScreen>> = {
      "conversation-detail": "conversations",
      "projects": "conversations",
      "project-prompts": "projects",
      "tasks": "projects",
      "detail": "tasks",
    };
    const handlePopState = (e: PopStateEvent) => {
      const prevScreen = (e.state as { mobileScreen?: MobileScreen } | null)?.mobileScreen;
      const target = prevScreen ?? BACK_MAP[mobileScreen] ?? "conversations";
      isHandlingPopState.current = true;
      setMobileScreen(target);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile, mobileScreen]);

  useEffect(() => {
    setMobileDetailTab("log");
    setMobilePromptExpanded(false);
    setExpandedDiffFiles({});
  }, [task?.id]);

  const copyToClipboard = async (content: string): Promise<boolean> => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        return true;
      }
      if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const copyPlanOutput = async () => {
    const content = planMarkdown || "Latest implementation plan from Codex runtime.";
    const copied = await copyToClipboard(content);
    if (copied) {
      setPlanCopyState("copied");
    } else {
      setPlanCopyState("error");
    }
    window.setTimeout(() => setPlanCopyState("idle"), 1500);
  };

  const copyPromptOutput = async () => {
    if (!task) {
      return;
    }
    const copied = await copyToClipboard(task.prompt);
    if (copied) {
      setPromptCopyState("copied");
    } else {
      setPromptCopyState("error");
    }
    window.setTimeout(() => setPromptCopyState("idle"), 1500);
  };

  const handleRunActionConfirm = (config: { model: string; executionMode: ExecutionMode }) => {
    if (!task || !pendingRunAction) {
      return;
    }
    if (typeof window !== "undefined" && config.model) {
      window.localStorage.setItem(LAST_TASK_MODEL_KEY, config.model);
    }
    setRunActionModel(config.model);
    setPendingExecutionMode(config.executionMode);
    setRunActionSheetOpen(false);
    setPendingRunAction(null);
    taskActionMutation.mutate({ action: "retryTask", taskId: task.id, model: config.model || undefined });
  };

  const handleSendFollowup = () => {
    if (!task) {
      return;
    }
    const message = followupDraft.trim();
    if (!message) {
      return;
    }
    followupMutation.mutate({ sessionId: task.session_id, content: message });
  };

  const renderTaskDetailContent = (mobile: boolean) => {
    if (!task) {
      return <p className="empty-state">Select a task to inspect the Task Workspace and approval state.</p>;
    }

    const runStatus = inferRunStatus(task.status);
    const runStatusLabel = getRunStatusLabel(runStatus);
    const primaryAction = getPrimaryAction(runStatus);
    const secondaryActions = getSecondaryActions(runStatus);
    const canApprove = task.status === "waiting_result_approval";
    const canStop = !["completed", "failed", "stopped"].includes(task.status);
    const canRunWithSelectedModel = runActionModelOptions.length > 0;
    const promptPreview = task.prompt.replace(/\s+/g, " ").trim();
    const compactPromptPreview =
      promptPreview.length > 180 ? `${promptPreview.slice(0, 180).trimEnd()}...` : promptPreview || "No prompt";
    // "Last event in the array" isn't reliably "most recent" now that the
    // default fetch excludes technical events -- the excluded types are
    // usually exactly what was most recently happening. The lean fetch's
    // own latestEventAt (computed server-side over the true full history)
    // is the accurate source; task.updated_at is the fallback for before
    // that response has come back, NOT a substitute for it (confirmed
    // live: a real task's updated_at sat 34 minutes stale behind its
    // actual last event, since SQLAlchemy only bumps it when an event
    // happens to also mutate a Task column, which most technical events
    // don't).
    const latestRunTimestamp = technicalEventsRequested
      ? events[events.length - 1]?.created_at ?? task.updated_at
      : taskEventsLeanQuery.data?.latestEventAt ?? task.updated_at;
    const followupDisabled = runStatus === "running" || task.status === "waiting_result_approval" || task.status === "waiting_user_input";

    const triggerRunAction = (action: RunExecutionAction) => {
      setPendingRunAction(action);
      setRunActionSheetOpen(true);
    };

    const handlePrimaryAction = () => {
      if (primaryAction.key === "stop") {
        taskActionMutation.mutate({ action: "stopTask", taskId: task.id });
        return;
      }
      if (primaryAction.key === "approve") {
        taskActionMutation.mutate({ action: "approveTask", taskId: task.id });
        return;
      }
      if (!mobile) {
        taskActionMutation.mutate({
          action: "retryTask",
          taskId: task.id,
          model: runActionModel || undefined
        });
        return;
      }
      triggerRunAction(primaryAction.key);
    };

    const isPrimaryDisabled =
      primaryAction.key === "stop"
        ? !canStop
        : primaryAction.key === "approve"
          ? !canApprove
          : !canRunWithSelectedModel;

    if (mobile) {
      return (
        <>
          <div className={`mobile-detail-control mobile-detail-control-${runStatus}`}>
            <div className="mobile-detail-control-top">
              <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("tasks")}>
                Back
              </button>
              <strong className="truncate">{task.title}</strong>
              <StatusBadge status={task.status} />
            </div>
            <div className="mobile-detail-action-row">
              <button
                type="button"
                className={primaryAction.intent === "danger" ? "status-action-danger" : ""}
                onClick={handlePrimaryAction}
                disabled={isPrimaryDisabled}
              >
                {primaryAction.label}
              </button>
              {secondaryActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (action.key === "reject") {
                      taskActionMutation.mutate({ action: "stopTask", taskId: task.id });
                      return;
                    }
                    setFollowupDraft("Please revise this result with tighter spacing.");
                    setMobileDetailTab("log");
                  }}
                  disabled={action.key === "reject" ? !canStop : followupDisabled}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          <section className="mobile-run-context">
            <h3>Run context</h3>
            <p>
              <strong>{runStatusLabel}</strong>
            </p>
            <p>Last run: {getRunResultLabel(runStatus)}</p>
            <p>{formatRelativeTime(latestRunTimestamp)}</p>
          </section>

          <details className="mobile-meta-section" open>
            <summary>Summary</summary>
            <div className="meta-grid mobile-meta-grid">
              <div>
                <span className="meta-label">Project</span>
                <strong className="break-value">{task.project?.name ?? "Unknown project"}</strong>
              </div>
              <div>
                <span className="meta-label">Model (effective)</span>
                <strong className="break-value mono">{task.effective_model ?? task.model ?? "Unknown"}</strong>
              </div>
              {task.profile ? (
                <div>
                  <span className="meta-label">Profile</span>
                  <strong className="break-value mono">{task.profile}</strong>
                </div>
              ) : null}
              <div>
                <span className="meta-label">Execution mode</span>
                <strong className="break-value">{task.execution_mode}</strong>
              </div>
              <div>
                <span className="meta-label">Reasoning</span>
                <strong className="break-value">{task.reasoning_effort ?? "medium"}</strong>
              </div>
            </div>
          </details>

          <div className="mobile-detail-tabs" role="tablist" aria-label="Task detail tabs">
            <button
              type="button"
              className={mobileDetailTab === "log" ? "active" : ""}
              role="tab"
              aria-selected={mobileDetailTab === "log"}
              onClick={() => setMobileDetailTab("log")}
            >
              Log
            </button>
            <button
              type="button"
              className={mobileDetailTab === "diff" ? "active" : ""}
              role="tab"
              aria-selected={mobileDetailTab === "diff"}
              onClick={() => setMobileDetailTab("diff")}
            >
              Diff
            </button>
          </div>

          <div className="mobile-detail-tab-panel">
            {mobileDetailTab === "log" ? (
              <div className="mobile-log-scroll">
                {latestPlan ? (
                  <section className="output-panel">
                    <div className="row-header">
                      <h3>Plan output</h3>
                      <button type="button" className="secondary" onClick={copyPlanOutput}>
                        Copy plan
                      </button>
                    </div>
                    {planCopyState === "copied" ? <p className="copy-status">Copied to clipboard.</p> : null}
                    {planCopyState === "error" ? <p className="copy-status">Copy failed.</p> : null}
                    <div className="plan-output">
                      <MarkdownRenderer markdown={planMarkdown || "Latest implementation plan from Codex runtime."} />
                    </div>
                  </section>
                ) : null}

                <section className="output-panel">
                  <div className="row-header">
                    <h3>Event log</h3>
                  </div>
                  <StructuredLogTab
                    events={events}
                    mobile
                    hiddenTechnicalCount={hiddenTechnicalCount}
                    onLoadFullTimeline={() => setTechnicalEventsRequested(true)}
                    isLoadingFullTimeline={taskEventsFullQuery.isFetching}
                  />
                  <SessionComposer
                    value={followupDraft}
                    onChange={setFollowupDraft}
                    onSend={handleSendFollowup}
                    disabled={followupDisabled}
                    pending={followupMutation.isPending}
                  />
                  {followupMutation.error instanceof Error ? <p role="alert">{followupMutation.error.message}</p> : null}
                </section>
              </div>
            ) : (
              <section className="output-panel mobile-diff-scroll">
                <div className="row-header">
                  <h3>Diff</h3>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => workspaceCommitMutation.mutate({ taskId: task.id, message: commitMessage.trim() })}
                      disabled={!task.workspace_path || !commitMessage.trim() || workspaceCommitMutation.isPending}
                    >
                      Commit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => workspacePushMutation.mutate({ taskId: task.id })}
                      disabled={!task.workspace_path || workspacePushMutation.isPending}
                    >
                      Push
                    </button>
                  </div>
                </div>
                <label className="retry-model-control retry-model-control-mobile">
                  Commit message
                  <input
                    aria-label="Commit message"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Apply Task Workspace updates"
                  />
                </label>
                {workspaceCommitMutation.error instanceof Error ? <p role="alert">{workspaceCommitMutation.error.message}</p> : null}
                {workspacePushMutation.error instanceof Error ? <p role="alert">{workspacePushMutation.error.message}</p> : null}
                {gitActionMessage ? <p className="copy-status">{gitActionMessage}</p> : null}
                <p>{diff?.summary && diff.summary.trim().length > 0 ? diff.summary : "Waiting for runtime diff."}</p>
                {diff?.raw_diff ? (
                  <GroupedDiff
                    rawDiff={diff.raw_diff}
                    filesChanged={diff.files_changed}
                    expanded={expandedDiffFiles}
                    onToggle={(id) =>
                      setExpandedDiffFiles((previous) => ({
                        ...previous,
                        [id]: !previous[id]
                      }))
                    }
                  />
                ) : (
                  <ul>
                    {diff?.files_changed.map((file: string) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>

          <section className="mobile-prompt-section">
            <div className="output-panel prompt-output">
              <div className="row-header">
                <h3>Input prompt</h3>
                {!mobilePromptExpanded ? (
                  <button type="button" className="secondary" onClick={() => setMobilePromptExpanded(true)}>
                    Expand
                  </button>
                ) : (
                  <div className="inline-actions">
                    <button type="button" className="secondary" onClick={() => setMobilePromptExpanded(false)}>
                      Collapse
                    </button>
                    <button type="button" className="secondary" onClick={copyPromptOutput}>
                      Copy
                    </button>
                  </div>
                )}
              </div>
              {mobilePromptExpanded ? (
                <>
                  {promptCopyState === "copied" ? <p className="copy-status">Prompt copied to clipboard.</p> : null}
                  {promptCopyState === "error" ? <p className="copy-status">Prompt copy failed.</p> : null}
                  <MarkdownRenderer markdown={task.prompt} />
                </>
              ) : (
                <p className="mobile-prompt-preview">{compactPromptPreview}</p>
              )}
            </div>
          </section>
        </>
      );
    }

    return (
      <>
        <div className="meta-grid">
          <div>
            <span className="meta-label">Project</span>
            <strong className="break-value">{task.project?.name ?? "Unknown project"}</strong>
          </div>
          <div>
            <span className="meta-label">Execution mode</span>
            <strong className="break-value">{task.execution_mode}</strong>
          </div>
          <div>
            <span className="meta-label">Effective model</span>
            <strong className="break-value mono">{task.effective_model ?? "Unknown"}</strong>
          </div>
          {taskDetailUsageInfo && (taskDetailUsageInfo.session || taskDetailUsageInfo.week) ? (
            <div>
              <span className="meta-label">Usage</span>
              <strong className="break-value">
                <UsageBadge usage={taskDetailUsageInfo} />
              </strong>
            </div>
          ) : null}
          {task.profile ? (
            <div>
              <span className="meta-label">Profile</span>
              <strong className="break-value mono">{task.profile}</strong>
            </div>
          ) : null}
          <div>
            <span className="meta-label">Reasoning effort</span>
            <strong className="break-value">{task.reasoning_effort ?? "medium"}</strong>
          </div>
          <div>
            <span className="meta-label">Task Workspace</span>
            <strong className="break-value mono">{task.workspace_ref}</strong>
            <span className="break-value mono">{task.workspace_path}</span>
          </div>
          <div>
            <span className="meta-label">Runtime session</span>
            <strong className="break-value mono">{task.runtime_session_id ?? "Not started"}</strong>
          </div>
        </div>

        <div className="action-row">
          <label className="retry-model-control">
            Retry model
            <select
              aria-label="Retry model"
              value={runActionModel}
              onChange={(event) => setRunActionModel(event.target.value)}
              disabled={runActionModelOptions.length === 0}
            >
              {runActionModelOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="retry-model-control">
            Commit message
            <input
              aria-label="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Apply Task Workspace updates"
            />
          </label>
          <button
            type="button"
            className={primaryAction.intent === "danger" ? "status-action-danger" : ""}
            onClick={handlePrimaryAction}
            disabled={isPrimaryDisabled}
          >
            {primaryAction.label}
          </button>
          {secondaryActions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="secondary"
              onClick={() => {
                if (action.key === "reject") {
                  taskActionMutation.mutate({ action: "stopTask", taskId: task.id });
                  return;
                }
                setFollowupDraft("Please revise this result with tighter spacing.");
              }}
              disabled={action.key === "reject" ? !canStop : followupDisabled}
            >
              {action.label}
            </button>
          ))}
          <button
            className="secondary"
            onClick={() => workspaceCommitMutation.mutate({ taskId: task.id, message: commitMessage.trim() })}
            disabled={!task.workspace_path || !commitMessage.trim() || workspaceCommitMutation.isPending}
          >
            Commit
          </button>
          <button
            className="secondary"
            onClick={() => workspacePushMutation.mutate({ taskId: task.id })}
            disabled={!task.workspace_path || workspacePushMutation.isPending}
          >
            Push
          </button>
        </div>
        <section className="run-context-panel">
          <h3>Run context</h3>
          <p>
            <strong>{runStatusLabel}</strong>
          </p>
          <p>Last run: {getRunResultLabel(runStatus)}</p>
          <p>{formatRelativeTime(latestRunTimestamp)}</p>
        </section>
        {workspaceCommitMutation.error instanceof Error ? <p role="alert">{workspaceCommitMutation.error.message}</p> : null}
        {workspacePushMutation.error instanceof Error ? <p role="alert">{workspacePushMutation.error.message}</p> : null}
        {gitActionMessage ? <p className="copy-status">{gitActionMessage}</p> : null}

        {task.status === "waiting_user_input" ? (
          <section className="panel form-panel">
            <div className="panel-header">
              <h3>User input required</h3>
              <p>Codex App Server paused the task and is waiting for structured input.</p>
            </div>
            {task.pending_questions.map((question) => (
              <label key={question.id}>
                {question.header || question.question}
                <span>{question.question}</span>
                {question.options?.length ? (
                  <small>
                    Options:{" "}
                    {question.options
                      .map((option) => option.label)
                      .filter(Boolean)
                      .join(", ")}
                  </small>
                ) : null}
                <input
                  aria-label={question.header || question.question}
                  type={question.is_secret ? "password" : "text"}
                  value={responseDraft[question.id] ?? ""}
                  onChange={(event) =>
                    setResponseDraft((previous) => ({ ...previous, [question.id]: event.target.value }))
                  }
                />
              </label>
            ))}
            <button
              onClick={() =>
                respondMutation.mutate({
                  taskId: task.id,
                  answers: Object.fromEntries(
                    Object.entries(responseDraft).map(([questionId, value]) => [questionId, value ? [value] : []])
                  )
                })
              }
              disabled={respondMutation.isPending || task.pending_questions.length === 0}
            >
              Send response
            </button>
          </section>
        ) : null}

        <div className="output-stack">
          <section>
            <div className="row-header">
              <h3>Input prompt</h3>
              <button type="button" className="secondary" onClick={copyPromptOutput}>
                Copy prompt
              </button>
            </div>
            {promptCopyState === "copied" ? <p className="copy-status">Prompt copied to clipboard.</p> : null}
            {promptCopyState === "error" ? <p className="copy-status">Prompt copy failed.</p> : null}
            <div className="output-panel prompt-output">
              <MarkdownRenderer markdown={task.prompt} />
            </div>
          </section>

          {latestPlan ? (
            <section>
              <div className="row-header">
                <h3>Plan output</h3>
                <button type="button" className="secondary" onClick={copyPlanOutput}>
                  Copy plan
                </button>
              </div>
              {planCopyState === "copied" ? <p className="copy-status">Copied to clipboard.</p> : null}
              {planCopyState === "error" ? <p className="copy-status">Copy failed.</p> : null}
              <div className="output-panel plan-output">
                <MarkdownRenderer markdown={planMarkdown || "Latest implementation plan from Codex runtime."} />
              </div>
            </section>
          ) : null}

          <section>
            <h3>Event log</h3>
            <div className="output-panel">
              <StructuredLogTab
                events={events}
                mobile={false}
                hiddenTechnicalCount={hiddenTechnicalCount}
                onLoadFullTimeline={() => setTechnicalEventsRequested(true)}
                isLoadingFullTimeline={taskEventsFullQuery.isFetching}
              />
              <SessionComposer
                value={followupDraft}
                onChange={setFollowupDraft}
                onSend={handleSendFollowup}
                disabled={followupDisabled}
                pending={followupMutation.isPending}
              />
              {followupMutation.error instanceof Error ? <p role="alert">{followupMutation.error.message}</p> : null}
            </div>
          </section>

          <section>
            <h3>Diff summary</h3>
            <div className="output-panel">
              <p>{diff?.summary && diff.summary.trim().length > 0 ? diff.summary : "Waiting for runtime diff."}</p>
              {diff?.raw_diff ? (
                <GroupedDiff
                  rawDiff={diff.raw_diff}
                  filesChanged={diff.files_changed}
                  expanded={expandedDiffFiles}
                  onToggle={(id) =>
                    setExpandedDiffFiles((previous) => ({
                      ...previous,
                      [id]: !previous[id]
                    }))
                  }
                />
              ) : (
                <ul>
                  {diff?.files_changed.map((file: string) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </>
    );
  };

  return (
    <div className="app-shell">
      <header className={isMobile ? "commander-header mobile-header" : "commander-header"}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
          <div className="header-copy">
            <p className="eyebrow">Web Commander</p>
            <h1>Agent Supervision Console</h1>
            <p className="hero-copy">Projects, tasks, and runtime detail in one stable control plane layout.</p>
          </div>
          {isNotificationSupported() ? (
            <button
              type="button"
              className="secondary notification-toggle-button"
              onClick={handleToggleTaskNotifications}
              title={
                taskNotificationsEnabled
                  ? "진행 중인 모든 작업의 완료/실패 알림이 켜져 있어요. 클릭하면 꺼져요."
                  : "켜면 지금 열려 있지 않은 대화를 포함해, 모든 작업이 끝날 때 브라우저 알림을 받아요."
              }
            >
              {taskNotificationsEnabled ? "🔔" : "🔕"}
            </button>
          ) : null}
        </div>
        <div className={isMobile ? "header-actions hidden-on-mobile" : "header-actions"}>
          {!isMobile ? (
            <div className="inline-actions" style={{ marginRight: "0.5rem" }}>
              <button
                type="button"
                className={desktopView === "chat" ? undefined : "secondary"}
                onClick={() => setDesktopView("chat")}
              >
                대화
              </button>
              <button
                type="button"
                className={desktopView === "workspace" ? undefined : "secondary"}
                onClick={() => setDesktopView("workspace")}
              >
                프로젝트
              </button>
            </div>
          ) : null}
          <button type="button" onClick={() => setProjectModalOpen(true)}>
            New Project
          </button>
          <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
            New Task
          </button>
        </div>
      </header>

      {isMobile ? (
        <main className="mobile-shell">
          {mobileScreen === "conversations" ? (
            <ConversationListScreen
              conversations={conversationsQuery.data ?? []}
              conversationCounts={conversationCountsQuery.data ?? {}}
              projects={projectsQuery.data ?? []}
              isLoading={conversationsQuery.isLoading}
              onSelect={(id) => {
                setSelectedConversationId(id);
                setMobileScreen("conversation-detail");
              }}
              onCreate={(projectId) => createConversationMutation.mutate(projectId)}
              onDelete={(id) => deleteConversationMutation.mutate(id)}
              onManageProjects={() => setMobileScreen("projects")}
            />
          ) : null}

          {mobileScreen === "conversation-detail" && selectedConversationId ? (
            <ConversationDetailScreen
              conversationId={selectedConversationId}
              onBack={() => setMobileScreen("conversations")}
            />
          ) : null}

          {mobileScreen === "projects" ? (
            <section className="panel mobile-screen">
              <div className="panel-header">
                <div className="row-header">
                  <div>
                    <div className="mobile-title-row">
                      <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("conversations")}>
                        Back
                      </button>
                      <h2>Projects</h2>
                    </div>
                  </div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => setProjectModalOpen(true)}>
                      New Project
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleDeleteProject}
                      disabled={!selectedProject || deleteProjectMutation.isPending}
                    >
                      {deleteProjectMutation.isPending ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="panel-scroll">
                <ProjectList
                  projects={projectsQuery.data}
                  selectedProjectId={selectedProjectId}
                  onSelect={(project) => {
                    setSelectedProjectId(project.id);
                    setSelectedTaskId(null);
                    setMobileScreen("tasks");
                  }}
                  onOpenPrompts={(project) => {
                    setSelectedProjectId(project.id);
                    setMobileScreen("project-prompts");
                  }}
                  emptyText="No projects yet."
                />
              </div>
            </section>
          ) : null}

          {mobileScreen === "project-prompts" ? (
            <ProjectPromptsScreen
              project={selectedProject}
              onBack={() => setMobileScreen("projects")}
            />
          ) : null}

          {mobileScreen === "tasks" ? (
            <section className="panel mobile-screen">
              <div className="panel-header mobile-title-row">
                <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("projects")}>
                  Back
                </button>
                <div>
                  <h2>Tasks</h2>
                  <p>{selectedProject?.name ?? "Select project"}</p>
                </div>
                <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
                  New Task
                </button>
              </div>
              <div className="panel-scroll">
                {selectedProject ? (
                  tasksQuery.data?.length ? (
                    tasksQuery.data.map((item) => (
                      <button
                        key={item.id}
                        className={item.id === selectedTaskId ? "task-row active" : "task-row"}
                        onClick={() => {
                          setSelectedTaskId(item.id);
                          setMobileScreen("detail");
                        }}
                        title={item.workspace_path ?? item.workspace_ref}
                      >
                        <div className="list-row">
                          <strong className="truncate">{item.title}</strong>
                          <StatusBadge status={item.status} />
                        </div>
                        <div className="task-meta-row">
                          <span className="item-secondary">{item.execution_mode}</span>
                          <span className="item-secondary mono truncate">{item.workspace_ref}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <p className="empty-state">No tasks yet for this project.</p>
                  )
                ) : (
                  <p className="empty-state">Select a project first.</p>
                )}
              </div>
            </section>
          ) : null}

          {mobileScreen === "detail" ? (
            <section className="panel mobile-screen detail-panel mobile-detail-screen">
              {renderTaskDetailContent(true)}
            </section>
          ) : null}
        </main>
      ) : desktopView === "chat" ? (
        // Same ConversationListScreen/ConversationDetailScreen the mobile
        // shell uses — desktop just shows them side by side instead of one
        // at a time. Building this as its own desktop-only chat UI is
        // exactly the duplication that let desktop fall behind before.
        <main className="chat-grid">
          <ConversationListScreen
            conversations={conversationsQuery.data ?? []}
            conversationCounts={conversationCountsQuery.data ?? {}}
            projects={projectsQuery.data ?? []}
            isLoading={conversationsQuery.isLoading}
            onSelect={(id) => setSelectedConversationId(id)}
            onCreate={(projectId) => createConversationMutation.mutate(projectId)}
            onDelete={(id) => deleteConversationMutation.mutate(id)}
          />
          {selectedConversationId ? (
            <ConversationDetailScreen
              key={selectedConversationId}
              conversationId={selectedConversationId}
              onBack={() => setSelectedConversationId(null)}
              showBackButton={false}
            />
          ) : (
            <section className="panel">
              <p className="empty-state">대화를 선택하거나 새로 시작하세요.</p>
            </section>
          )}
        </main>
      ) : (
        <main className="workspace-grid">
          <section className="panel sidebar">
            <div className="panel-header">
              <div className="row-header">
                <div>
                  <h2>Projects</h2>
                  <p>Connected repositories</p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleDeleteProject}
                  disabled={!selectedProject || deleteProjectMutation.isPending}
                >
                  {deleteProjectMutation.isPending ? "Deleting..." : "Delete Project"}
                </button>
              </div>
            </div>
            <div className="panel-scroll">
              <ProjectList
                projects={projectsQuery.data}
                selectedProjectId={selectedProjectId}
                onSelect={(project) => {
                  setSelectedProjectId(project.id);
                  setSelectedTaskId(null);
                }}
                onOpenPrompts={(project) => {
                  setSelectedProjectId(project.id);
                  setPromptsModalOpen(true);
                }}
                emptyText="No projects yet. Create one from New Project."
              />
            </div>
          </section>

          <section className="panel tasks-panel">
            <div className="panel-header">
              <div className="row-header">
                <div>
                  <h2>Tasks</h2>
                  <p>{selectedProject ? selectedProject.name : "Select a project first"}</p>
                </div>
                <div className="row-header-actions">
                  <button
                    type="button"
                    className="btn-danger-sm"
                    disabled={!selectedTaskId}
                    onClick={() => {
                      if (selectedTaskId && window.confirm("Delete this task?")) {
                        deleteTaskMutation.mutate(selectedTaskId);
                      }
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
                    + New Task
                  </button>
                </div>
              </div>
            </div>
            <div className="panel-scroll">
              {selectedProject ? (
                tasksQuery.data?.length ? (
                  tasksQuery.data.map((item) => (
                    <button
                      key={item.id}
                      className={item.id === selectedTaskId ? "task-row active" : "task-row"}
                      onClick={() => setSelectedTaskId(item.id)}
                      title={item.workspace_path ?? item.workspace_ref}
                    >
                      <div className="list-row">
                        <strong className="truncate">{item.title}</strong>
                        <StatusBadge status={item.status} />
                      </div>
                      <div className="task-meta-row">
                        <span className="item-secondary">{item.execution_mode}</span>
                        <span className="item-secondary mono truncate">{item.workspace_ref}</span>
                      </div>
                      <span className="item-secondary mono truncate">{item.workspace_path ?? "workspace pending"}</span>
                    </button>
                  ))
                ) : (
                  <p className="empty-state">No tasks yet for this project.</p>
                )
              ) : (
                <p className="empty-state">Select a project to browse tasks.</p>
              )}
            </div>
          </section>

          <section className="panel detail-panel">
            <div className="panel-header">
              <div>
                <h2>Task Detail</h2>
                <p>Orchestration API view into the active Codex App Server session.</p>
              </div>
              {task ? <StatusBadge status={task.status} /> : null}
            </div>
            <div className="detail-scroll">
              {renderTaskDetailContent(false)}
            </div>
          </section>
        </main>
      )}

      <RunActionSheet
        open={runActionSheetOpen}
        action={pendingRunAction}
        defaultModel={runActionModel}
        defaultExecutionMode={pendingExecutionMode}
        models={runActionModelOptions}
        onClose={() => {
          setRunActionSheetOpen(false);
          setPendingRunAction(null);
        }}
        onConfirm={handleRunActionConfirm}
      />

      <Modal title="New Project" open={projectModalOpen} onClose={() => setProjectModalOpen(false)} isMobile={isMobile}>
        <ProjectForm onCreate={(payload) => createProjectMutation.mutate(payload)} onClose={() => setProjectModalOpen(false)} />
      </Modal>

      <ProjectPromptsModal
        project={selectedProject}
        open={promptsModalOpen}
        onClose={() => setPromptsModalOpen(false)}
      />

      <Modal
        title="New Task"
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        fullScreenMobile
        isMobile={isMobile}
      >
        <TaskForm
          project={selectedProject}
          isMobile={isMobile}
          onCreate={(payload) => createTaskMutation.mutate(payload)}
          onClose={() => setTaskModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
