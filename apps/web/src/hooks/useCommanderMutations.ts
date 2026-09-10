import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary, ProjectSummary } from "@zenbar/shared";
import { api } from "../api";
import { actor } from "../lib/constants";
import type { MobileScreen } from "../lib/viewState";

interface UseCommanderMutationsOptions {
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  selectedConversationId: string | null;
  selectedProject: ProjectSummary | null;
  setSelectedProjectId: (id: string | null) => void;
  setSelectedTaskId: (id: string | null) => void;
  setSelectedConversationId: (id: string | null) => void;
  setMobileScreen: (screen: MobileScreen) => void;
  setProjectModalOpen: (open: boolean) => void;
  setTaskModalOpen: (open: boolean) => void;
  setResponseDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setFollowupDraft: (draft: string) => void;
  setMobileDetailTab: (tab: "log" | "diff") => void;
  setGitActionMessage: (msg: string | null) => void;
}

export function useCommanderMutations({
  selectedProjectId,
  selectedTaskId,
  selectedConversationId,
  selectedProject,
  setSelectedProjectId,
  setSelectedTaskId,
  setSelectedConversationId,
  setMobileScreen,
  setProjectModalOpen,
  setTaskModalOpen,
  setResponseDraft,
  setFollowupDraft,
  setMobileDetailTab,
  setGitActionMessage,
}: UseCommanderMutationsOptions) {
  const queryClient = useQueryClient();

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

  // Fire-and-forget: the unread dot clearing a beat late is harmless, but
  // making the user wait on a network round trip before a conversation even
  // opens is not. The optimistic setQueriesData below (prefix-matched, so it
  // covers both the preview list and the "show all" full list without
  // hardcoding either query's exact key) is what actually clears the dot
  // instantly -- the mutation is just there to persist it server-side for
  // next time / other devices.
  const markConversationReadMutation = useMutation({
    mutationFn: (id: string) => api.markConversationRead(id),
  });

  const handleSelectConversation = (id: string) => {
    setSelectedConversationId(id);
    queryClient.setQueriesData<ConversationSummary[]>({ queryKey: ["conversations"] }, (previous) =>
      previous?.map((conv) => (conv.id === id && conv.is_unread ? { ...conv, is_unread: false } : conv))
    );
    markConversationReadMutation.mutate(id);
  };

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

  return {
    createConversationMutation,
    deleteConversationMutation,
    markConversationReadMutation,
    handleSelectConversation,
    createProjectMutation,
    createTaskMutation,
    deleteProjectMutation,
    deleteTaskMutation,
    taskActionMutation,
    respondMutation,
    followupMutation,
    workspaceCommitMutation,
    workspacePushMutation,
    handleDeleteProject,
  };
}
