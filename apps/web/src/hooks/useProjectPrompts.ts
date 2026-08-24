// Saved-prompt queries and mutations for one project.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectPrompt,
  ProjectSummary
} from "@zenbar/shared";
import { api } from "../api";

export function useProjectPrompts(project: ProjectSummary | null) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<ProjectPrompt | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const promptsQuery = useQuery({
    queryKey: ["project-prompts", project?.id ?? null],
    queryFn: () => api.listProjectPrompts(project!.id),
    enabled: Boolean(project),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["project-prompts", project?.id ?? null] });

  const closeForm = () => {
    setFormOpen(false);
    setEditingPrompt(null);
    setTitle("");
    setContent("");
  };

  const createMutation = useMutation({
    mutationFn: (payload: { title: string; content: string }) => api.createProjectPrompt(project!.id, payload),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: Error) => alert(`프롬프트 저장 실패: ${err.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; title: string; content: string }) =>
      api.updateProjectPrompt(project!.id, payload.id, { title: payload.title, content: payload.content }),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: Error) => alert(`프롬프트 수정 실패: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (promptId: string) => api.deleteProjectPrompt(project!.id, promptId),
    onSuccess: () => invalidate(),
    onError: (err: Error) => alert(`프롬프트 삭제 실패: ${err.message}`),
  });

  const queryKey = ["project-prompts", project?.id ?? null];
  const reorderMutation = useMutation({
    mutationFn: (promptIds: string[]) => api.reorderProjectPrompts(project!.id, { prompt_ids: promptIds }),
    // Optimistic: a ▲/▼ click should feel instant, not wait on a round
    // trip -- reorder the cached list immediately, and only fall back to
    // the pre-move snapshot if the request actually fails.
    onMutate: async (promptIds) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ProjectPrompt[]>(queryKey);
      if (previous) {
        const byId = new Map(previous.map((p) => [p.id, p]));
        const reordered = promptIds.map((id) => byId.get(id)).filter((p): p is ProjectPrompt => Boolean(p));
        queryClient.setQueryData(queryKey, reordered);
      }
      return { previous };
    },
    onError: (err: Error, _promptIds, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      alert(`순서 변경 실패: ${err.message}`);
    },
    onSettled: () => invalidate(),
  });

  const movePrompt = (promptId: string, direction: "up" | "down") => {
    const current = promptsQuery.data ?? [];
    const index = current.findIndex((p) => p.id === promptId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return;
    const reordered = [...current];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    reorderMutation.mutate(reordered.map((p) => p.id));
  };

  const openCreateForm = () => {
    setEditingPrompt(null);
    setTitle("");
    setContent("");
    setFormOpen(true);
  };

  const openEditForm = (prompt: ProjectPrompt) => {
    setEditingPrompt(prompt);
    setTitle(prompt.title);
    setContent(prompt.content);
    setFormOpen(true);
  };

  const canSubmit = Boolean(title.trim() && content.trim());
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const submitForm = () => {
    if (!canSubmit) return;
    if (editingPrompt) {
      updateMutation.mutate({ id: editingPrompt.id, title: title.trim(), content: content.trim() });
    } else {
      createMutation.mutate({ title: title.trim(), content: content.trim() });
    }
  };

  return {
    promptsQuery,
    deleteMutation,
    movePrompt,
    reorderMutation,
    formOpen,
    editingPrompt,
    title,
    setTitle,
    content,
    setContent,
    openCreateForm,
    openEditForm,
    closeForm,
    canSubmit,
    isSaving,
    submitForm,
  };
}
