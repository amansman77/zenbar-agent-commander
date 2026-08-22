// The task's own panel: status, run actions, pending questions, plan, log,
// diff and prompt. Rendered by App.tsx in both shells -- the mobile screen
// and the desktop workspace column -- which is why it takes `mobile` and
// branches on it rather than being two components with duplicated wiring.
//
// Its props are the panel's whole dependency surface on App.tsx state. That
// list is long because App still owns this state; it is at least explicit
// here, where it used to be an implicit closure over the root component.

import type { Dispatch, SetStateAction } from "react";
import type {
  RuntimeUsageInfo,
  TaskDetail,
  TaskDiff,
  TaskEvent
} from "@zenbar/shared";
import { formatRelativeTime } from "../lib/format";
import type { PlanSnapshot } from "../lib/taskEvents";
import { getPrimaryAction, getRunResultLabel, getRunStatusLabel, getSecondaryActions, inferRunStatus } from "../lib/taskStatus";
import type { RunExecutionAction } from "../lib/taskStatus";
import type { MobileScreen } from "../lib/viewState";
import { StatusBadge, UsageBadge } from "./Badges";
import { GroupedDiff } from "./DiffView";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { SessionComposer } from "./SessionComposer";
import { StructuredLogTab } from "./TaskTimeline";

type MutationLike<TInput> = {
  mutate: (input: TInput) => void;
  isPending: boolean;
  error: unknown;
};

export type TaskDetailPanelProps = {
  // Rendered in both shells, with two quite different trees -- see the
  // `if (mobile)` branch below.
  mobile: boolean;

  task: TaskDetail | null;
  events: TaskEvent[];
  diff: TaskDiff | null | undefined;
  latestPlan: PlanSnapshot | null;
  planMarkdown: string;
  hiddenTechnicalCount: number;
  latestEventAt: string | null | undefined;
  taskDetailUsageInfo: RuntimeUsageInfo | null;

  technicalEventsRequested: boolean;
  setTechnicalEventsRequested: Dispatch<SetStateAction<boolean>>;
  technicalEventsLoading: boolean;

  runActionModel: string;
  setRunActionModel: Dispatch<SetStateAction<string>>;
  runActionModelOptions: string[];
  setPendingRunAction: Dispatch<SetStateAction<RunExecutionAction | null>>;
  setRunActionSheetOpen: Dispatch<SetStateAction<boolean>>;
  taskActionMutation: MutationLike<{
    action: "approveTask" | "stopTask" | "retryTask";
    taskId: string;
    model?: string;
  }>;

  responseDraft: Record<string, string>;
  setResponseDraft: Dispatch<SetStateAction<Record<string, string>>>;
  respondMutation: MutationLike<{ taskId: string; answers: Record<string, string[]> }>;

  followupDraft: string;
  setFollowupDraft: Dispatch<SetStateAction<string>>;
  followupMutation: MutationLike<{ sessionId: string; content: string }>;
  handleSendFollowup: () => void;

  commitMessage: string;
  setCommitMessage: Dispatch<SetStateAction<string>>;
  gitActionMessage: string | null;
  workspaceCommitMutation: MutationLike<{ taskId: string; message: string }>;
  workspacePushMutation: MutationLike<{ taskId: string }>;

  expandedDiffFiles: Record<string, boolean>;
  setExpandedDiffFiles: Dispatch<SetStateAction<Record<string, boolean>>>;

  planCopyState: "idle" | "copied" | "error";
  promptCopyState: "idle" | "copied" | "error";
  copyPlanOutput: () => void;
  copyPromptOutput: () => void;

  mobileDetailTab: "log" | "diff";
  setMobileDetailTab: Dispatch<SetStateAction<"log" | "diff">>;
  mobilePromptExpanded: boolean;
  setMobilePromptExpanded: Dispatch<SetStateAction<boolean>>;
  setMobileScreen: Dispatch<SetStateAction<MobileScreen>>;
};

export function TaskDetailPanel({
  mobile,
  task,
  events,
  diff,
  latestPlan,
  planMarkdown,
  hiddenTechnicalCount,
  latestEventAt,
  taskDetailUsageInfo,
  technicalEventsRequested,
  setTechnicalEventsRequested,
  technicalEventsLoading,
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
  setMobileScreen,
}: TaskDetailPanelProps) {
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
    : latestEventAt ?? task.updated_at;
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
                  isLoadingFullTimeline={technicalEventsLoading}
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
              isLoadingFullTimeline={technicalEventsLoading}
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
}
