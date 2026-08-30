// Saved-prompt queries and mutations for the global (not project-scoped)
// prompt library -- a close mirror of useProjectPrompts.ts, minus the
// project scoping.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GlobalPrompt
} from "@zenbar/shared";
import { api } from "../api";

const queryKey = ["global-prompts"];

export function useGlobalPrompts() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<GlobalPrompt | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const promptsQuery = useQuery({
    queryKey,
    queryFn: api.listGlobalPrompts,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const closeForm = () => {
    setFormOpen(false);
    setEditingPrompt(null);
    setTitle("");
    setContent("");
  };

  const createMutation = useMutation({
    mutationFn: (payload: { title: string; content: string }) => api.createGlobalPrompt(payload),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: Error) => alert(`프롬프트 저장 실패: ${err.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; title: string; content: string }) =>
      api.updateGlobalPrompt(payload.id, { title: payload.title, content: payload.content }),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: Error) => alert(`프롬프트 수정 실패: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (promptId: string) => api.deleteGlobalPrompt(promptId),
    onSuccess: () => invalidate(),
    onError: (err: Error) => alert(`프롬프트 삭제 실패: ${err.message}`),
  });

  const reorderMutation = useMutation({
    mutationFn: (promptIds: string[]) => api.reorderGlobalPrompts({ prompt_ids: promptIds }),
    // Optimistic, same reasoning as useProjectPrompts' own reorder: a ▲/▼
    // click should feel instant.
    onMutate: async (promptIds) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<GlobalPrompt[]>(queryKey);
      if (previous) {
        const byId = new Map(previous.map((p) => [p.id, p]));
        const reordered = promptIds.map((id) => byId.get(id)).filter((p): p is GlobalPrompt => Boolean(p));
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

  const openEditForm = (prompt: GlobalPrompt) => {
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
