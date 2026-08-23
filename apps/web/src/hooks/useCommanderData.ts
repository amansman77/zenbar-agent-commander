// Everything App.tsx reads from the server for the current selection.
//
// Twelve queries plus the values derived from them, in one place, so the root
// component is left holding selection state, mutations and the shell rather
// than also being the data layer. Returns plain values rather than query
// objects -- callers only ever wanted `.data` and two loading flags.
//
// useTaskStream lives here too: it keeps these same caches live over SSE while
// a task is open.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { CONVERSATION_GROUP_PREVIEW_COUNT, USAGE_SUPPORTED_ENGINES } from "../lib/constants";
import { extractLatestPlan } from "../lib/taskEvents";
import { useTaskStream } from "./useTaskStream";

export function useCommanderData(selectedProjectId: string | null, selectedTaskId: string | null) {
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
  return {
    projects: projectsQuery.data,
    selectedProject,
    tasks: tasksQuery.data,
    runtimeProfiles: runtimeProfilesQuery.data,
    runtimeModels: runtimeModelsQuery.data,

    task,
    diff,
    events,
    latestPlan,
    planMarkdown,
    runActionModelOptions,
    taskDetailUsageInfo,

    // The event list is fetched lean by default; the full one only once the
    // user asks for it. See the queries above for why.
    hiddenTechnicalCount,
    latestEventAt: taskEventsLeanQuery.data?.latestEventAt,
    technicalEventsRequested,
    setTechnicalEventsRequested,
    technicalEventsLoading: taskEventsFullQuery.isFetching,

    conversations: conversationsQuery.data,
    conversationsLoading: conversationsQuery.isLoading,
    conversationCounts: conversationCountsQuery.data
  };
}
