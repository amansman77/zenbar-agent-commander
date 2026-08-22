// Prompt-pipeline queries and mutations for one project.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectPipeline,
  ProjectSummary
} from "@zenbar/shared";
import { api } from "../api";

export function useProjectPipelines(project: ProjectSummary | null) {
  const queryClient = useQueryClient();
  const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
  const [pipelineName, setPipelineName] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<ProjectPipeline | null>(null);

  const pipelinesQuery = useQuery({
    queryKey: ["project-pipelines", project?.id ?? null],
    queryFn: () => api.listProjectPipelines(project!.id),
    enabled: Boolean(project),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["project-pipelines", project?.id ?? null] });

  const togglePrompt = (promptId: string) => {
    setSelectedPromptIds((previous) =>
      previous.includes(promptId) ? previous.filter((id) => id !== promptId) : [...previous, promptId]
    );
  };

  const openBuilder = () => {
    setEditingPipeline(null);
    setSelectedPromptIds([]);
    setPipelineName("");
    setBuilderOpen(true);
  };

  const openEditor = (pipeline: ProjectPipeline) => {
    setEditingPipeline(pipeline);
    setSelectedPromptIds(pipeline.prompt_ids);
    setPipelineName(pipeline.name);
    setBuilderOpen(true);
  };

  const closeBuilder = () => {
    setBuilderOpen(false);
    setEditingPipeline(null);
    setSelectedPromptIds([]);
    setPipelineName("");
  };

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; prompt_ids: string[] }) => api.createProjectPipeline(project!.id, payload),
    onSuccess: () => {
      invalidate();
      closeBuilder();
    },
    onError: (err: Error) => alert(`파이프라인 저장 실패: ${err.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; name: string; prompt_ids: string[] }) =>
      api.updateProjectPipeline(project!.id, payload.id, { name: payload.name, prompt_ids: payload.prompt_ids }),
    onSuccess: () => {
      invalidate();
      closeBuilder();
    },
    onError: (err: Error) => alert(`파이프라인 수정 실패: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (pipelineId: string) => api.deleteProjectPipeline(project!.id, pipelineId),
    onSuccess: () => invalidate(),
    onError: (err: Error) => alert(`파이프라인 삭제 실패: ${err.message}`),
  });

  const canSave = Boolean(pipelineName.trim() && selectedPromptIds.length > 0);

  const submitPipeline = () => {
    if (!canSave) return;
    if (editingPipeline) {
      updateMutation.mutate({ id: editingPipeline.id, name: pipelineName.trim(), prompt_ids: selectedPromptIds });
    } else {
      createMutation.mutate({ name: pipelineName.trim(), prompt_ids: selectedPromptIds });
    }
  };

  return {
    pipelinesQuery,
    selectedPromptIds,
    togglePrompt,
    pipelineName,
    setPipelineName,
    builderOpen,
    editingPipeline,
    openBuilder,
    openEditor,
    closeBuilder,
    canSave,
    isSaving: createMutation.isPending || updateMutation.isPending,
    submitPipeline,
    deleteMutation,
  };
}
