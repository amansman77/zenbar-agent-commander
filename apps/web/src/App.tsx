// Root component: owns the selected project/task/conversation state, all
// top-level queries and mutations, and renders either the mobile screen stack or
// the desktop chat/workspace shell. Screens and components live alongside it in
// screens/, components/, hooks/ and lib/.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ExecutionMode,
  ProjectSummary
} from "@zenbar/shared";
import { api } from "./api";
import { StatusBadge } from "./components/Badges";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { Modal } from "./components/Modal";
import { ProjectForm } from "./components/ProjectForm";
import { ProjectList } from "./components/ProjectList";
import { RunActionSheet } from "./components/RunActionSheet";
import { TaskForm } from "./components/TaskForm";
import { useCommanderData } from "./hooks/useCommanderData";
import { useIsMobileBreakpoint } from "./hooks/useIsMobileBreakpoint";
import { useTaskCompletionNotifications } from "./hooks/useTaskCompletionNotifications";
import { LAST_TASK_MODEL_KEY, actor } from "./lib/constants";
import { TASK_NOTIFICATIONS_ENABLED_KEY, isNotificationSupported, loadTaskNotificationsEnabled } from "./lib/notifications";
import { defaultAnswers } from "./lib/taskQuestions";
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

  const {
    projects,
    selectedProject,
    tasks,
    runtimeProfiles,
    runtimeModels,
    task,
    diff,
    events,
    latestPlan,
    planMarkdown,
    runActionModelOptions,
    taskDetailUsageInfo,
    hiddenTechnicalCount,
    latestEventAt,
    technicalEventsRequested,
    setTechnicalEventsRequested,
    technicalEventsLoading,
    conversations,
    conversationsLoading,
    conversationCounts
  } = useCommanderData(selectedProjectId, selectedTaskId);

  const [taskNotificationsEnabled, setTaskNotificationsEnabled] = useState(loadTaskNotificationsEnabled);
  useTaskCompletionNotifications(conversations, taskNotificationsEnabled);

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

  // Everything the task detail panel reads out of this component. Assembled
  // once and spread at both call sites (mobile screen, desktop column) so the
  // two stay in step.
  const taskDetailPanelProps = {
    task,
    events,
    diff,
    latestPlan,
    planMarkdown,
    hiddenTechnicalCount,
    latestEventAt: latestEventAt,
    taskDetailUsageInfo,
    technicalEventsRequested,
    setTechnicalEventsRequested,
    technicalEventsLoading: technicalEventsLoading,
    runActionModel,
    setRunActionModel,
    runActionModelOptions,
    setPendingRunAction,
    setRunActionSheetOpen,
    taskActionMutation,
    responseDraft,
    setResponseDraft,
    respondMutation,
    followupDraft,
    setFollowupDraft,
    followupMutation,
    handleSendFollowup,
    commitMessage,
    setCommitMessage,
    gitActionMessage,
    workspaceCommitMutation,
    workspacePushMutation,
    expandedDiffFiles,
    setExpandedDiffFiles,
    planCopyState,
    promptCopyState,
    copyPlanOutput,
    copyPromptOutput,
    mobileDetailTab,
    setMobileDetailTab,
    mobilePromptExpanded,
    setMobilePromptExpanded,
    setMobileScreen
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
              conversations={conversations ?? []}
              conversationCounts={conversationCounts ?? {}}
              projects={projects ?? []}
              isLoading={conversationsLoading}
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
                  projects={projects}
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
                  tasks?.length ? (
                    tasks.map((item) => (
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
              <TaskDetailPanel mobile {...taskDetailPanelProps} />
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
            conversations={conversations ?? []}
            conversationCounts={conversationCounts ?? {}}
            projects={projects ?? []}
            isLoading={conversationsLoading}
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
                projects={projects}
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
                tasks?.length ? (
                  tasks.map((item) => (
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
              <TaskDetailPanel mobile={false} {...taskDetailPanelProps} />
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
