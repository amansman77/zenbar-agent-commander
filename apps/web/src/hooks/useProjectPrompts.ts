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
