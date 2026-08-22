// Combines the prompt and pipeline hooks with the editing/selection state the
// prompts screen and prompts modal both need, and returns the shared panels.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ProjectSummary
} from "@zenbar/shared";
import { ImportPromptsDialog } from "../components/prompts/ImportPromptsDialog";
import { ProjectPipelineBuilder } from "../components/prompts/ProjectPipelineBuilder";
import { ProjectPipelineList } from "../components/prompts/ProjectPipelineList";
import { ProjectPromptForm } from "../components/prompts/ProjectPromptForm";
import { ProjectPromptList } from "../components/prompts/ProjectPromptList";
import { useProjectPipelines } from "./useProjectPipelines";
import { useProjectPrompts } from "./useProjectPrompts";

// Single source of truth for the prompts/pipelines UI. Both the mobile
// full-screen and the desktop modal presentations are thin shells around
// this — previously they were two ~110-line near-copies, which is how the
// desktop side kept drifting behind (every prompts/pipelines change had to
// be made twice, by hand, in two places).
export function useProjectPromptsWorkspace(project: ProjectSummary | null) {
  const queryClient = useQueryClient();
  const pm = useProjectPrompts(project);
  const pl = useProjectPipelines(project);
  const [tab, setTab] = useState<"prompts" | "pipelines">("prompts");
  const [importOpen, setImportOpen] = useState(false);

  // Returned unwrapped: `.inline-actions` is inline-flex, so sibling
  // instances lay out side by side. Each shell supplies its own
  // `.inline-actions` wrapper (with its own spacing) — adding one here as
  // well would nest a block element and break that row onto two lines.
  const tabButtons = (
    <>
      <button type="button" className={tab === "prompts" ? undefined : "secondary"} onClick={() => setTab("prompts")}>
        프롬프트
      </button>
      <button type="button" className={tab === "pipelines" ? undefined : "secondary"} onClick={() => setTab("pipelines")}>
        파이프라인
      </button>
    </>
  );

  const addButton = (labels: { prompt: string; pipeline: string }) =>
    tab === "prompts" ? (
      <button type="button" onClick={pm.openCreateForm} disabled={!project}>
        {labels.prompt}
      </button>
    ) : (
      <button type="button" onClick={pl.openBuilder} disabled={!project}>
        {labels.pipeline}
      </button>
    );

  const list =
    tab === "prompts" ? (
      <ProjectPromptList
        prompts={pm.promptsQuery.data}
        isLoading={pm.promptsQuery.isLoading}
        hasProject={Boolean(project)}
        deletePending={pm.deleteMutation.isPending}
        onEdit={pm.openEditForm}
        onDelete={(prompt) => {
          if (confirm(`"${prompt.title}" 프롬프트를 삭제할까요?`)) {
            pm.deleteMutation.mutate(prompt.id);
          }
        }}
      />
    ) : (
      <ProjectPipelineList
        pipelines={pl.pipelinesQuery.data}
        prompts={pm.promptsQuery.data}
        isLoading={pl.pipelinesQuery.isLoading}
        hasProject={Boolean(project)}
        deletePending={pl.deleteMutation.isPending}
        onEdit={pl.openEditor}
        onDelete={(pipeline) => {
          if (confirm(`"${pipeline.name}" 파이프라인을 삭제할까요?`)) {
            pl.deleteMutation.mutate(pipeline.id);
          }
        }}
      />
    );

  const promptForm = (
    <ProjectPromptForm
      title={pm.title}
      setTitle={pm.setTitle}
      content={pm.content}
      setContent={pm.setContent}
      onSubmit={pm.submitForm}
      onCancel={pm.closeForm}
      canSubmit={pm.canSubmit}
      isSaving={pm.isSaving}
    />
  );

  const pipelineBuilder = (
    <ProjectPipelineBuilder
      prompts={pm.promptsQuery.data}
      selectedPromptIds={pl.selectedPromptIds}
      onTogglePrompt={pl.togglePrompt}
      name={pl.pipelineName}
      setName={pl.setPipelineName}
      onSubmit={pl.submitPipeline}
      onCancel={pl.closeBuilder}
      canSave={pl.canSave}
      isSaving={pl.isSaving}
      isEditing={Boolean(pl.editingPipeline)}
    />
  );

  const importButton =
    tab === "prompts" && project ? (
      <button type="button" className="secondary" onClick={() => setImportOpen(true)}>
        가져오기
      </button>
    ) : null;

  const closeImport = () => setImportOpen(false);

  const importDialog =
    importOpen && project ? (
      <ImportPromptsDialog
        currentProject={project}
        onClose={closeImport}
        onImported={() => queryClient.invalidateQueries({ queryKey: ["project-prompts", project.id] })}
      />
    ) : null;

  return {
    pm,
    pl,
    tab,
    tabButtons,
    addButton,
    importButton,
    importOpen,
    closeImport,
    importDialog,
    list,
    promptForm,
    pipelineBuilder,
    promptFormTitle: pm.editingPrompt ? "Edit prompt" : "New prompt",
    pipelineFormTitle: pl.editingPipeline ? "파이프라인 편집" : "새 파이프라인",
    closeAll: () => {
      pm.closeForm();
      pl.closeBuilder();
      setImportOpen(false);
    },
  };
}
