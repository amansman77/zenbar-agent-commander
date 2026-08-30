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
import { useGlobalPrompts } from "./useGlobalPrompts";
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
  const gp = useGlobalPrompts();
  const pl = useProjectPipelines(project);
  const [tab, setTab] = useState<"prompts" | "global" | "pipelines">("prompts");
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
      {/* Global prompts aren't scoped to any project (see GlobalPrompt's
          own docstring) -- reused across every project instead of
          copy-pasted into each one's own list, which is what the existing
          가져오기 import dialog only ever did. */}
      <button type="button" className={tab === "global" ? undefined : "secondary"} onClick={() => setTab("global")}>
        전역 프롬프트
      </button>
      <button type="button" className={tab === "pipelines" ? undefined : "secondary"} onClick={() => setTab("pipelines")}>
        파이프라인
      </button>
    </>
  );

  const addButton = (labels: { prompt: string; pipeline: string }) =>
    tab === "pipelines" ? (
      <button type="button" onClick={pl.openBuilder} disabled={!project}>
        {labels.pipeline}
      </button>
    ) : tab === "global" ? (
      <button type="button" onClick={gp.openCreateForm}>
        {labels.prompt}
      </button>
    ) : (
      <button type="button" onClick={pm.openCreateForm} disabled={!project}>
        {labels.prompt}
      </button>
    );

  const list =
    tab === "pipelines" ? (
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
    ) : tab === "global" ? (
      <ProjectPromptList
        prompts={gp.promptsQuery.data}
        isLoading={gp.promptsQuery.isLoading}
        hasProject
        deletePending={gp.deleteMutation.isPending}
        reorderPending={gp.reorderMutation.isPending}
        onEdit={gp.openEditForm}
        onDelete={(prompt) => {
          if (confirm(`"${prompt.title}" 전역 프롬프트를 삭제할까요?`)) {
            gp.deleteMutation.mutate(prompt.id);
          }
        }}
        onMoveUp={(prompt) => gp.movePrompt(prompt.id, "up")}
        onMoveDown={(prompt) => gp.movePrompt(prompt.id, "down")}
      />
    ) : (
      <ProjectPromptList
        prompts={pm.promptsQuery.data}
        isLoading={pm.promptsQuery.isLoading}
        hasProject={Boolean(project)}
        deletePending={pm.deleteMutation.isPending}
        reorderPending={pm.reorderMutation.isPending}
        onEdit={pm.openEditForm}
        onDelete={(prompt) => {
          if (confirm(`"${prompt.title}" 프롬프트를 삭제할까요?`)) {
            pm.deleteMutation.mutate(prompt.id);
          }
        }}
        onMoveUp={(prompt) => pm.movePrompt(prompt.id, "up")}
        onMoveDown={(prompt) => pm.movePrompt(prompt.id, "down")}
      />
    );

  const activePromptEditor = tab === "global" ? gp : pm;
  const promptForm = (
    <ProjectPromptForm
      title={activePromptEditor.title}
      setTitle={activePromptEditor.setTitle}
      content={activePromptEditor.content}
      setContent={activePromptEditor.setContent}
      onSubmit={activePromptEditor.submitForm}
      onCancel={activePromptEditor.closeForm}
      canSubmit={activePromptEditor.canSubmit}
      isSaving={activePromptEditor.isSaving}
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
    gp,
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
    // Which editor's open/editing state actually backs the shared
    // promptForm above -- pm's or gp's, whichever tab is active. Exposed
    // so the modal wrapping promptForm opens/closes off the right one
    // instead of always pm's (which would silently ignore edits made from
    // the 전역 프롬프트 tab).
    activePromptEditor,
    pipelineBuilder,
    promptFormTitle: activePromptEditor.editingPrompt ? "Edit prompt" : "New prompt",
    pipelineFormTitle: pl.editingPipeline ? "파이프라인 편집" : "새 파이프라인",
    closeAll: () => {
      pm.closeForm();
      gp.closeForm();
      pl.closeBuilder();
      setImportOpen(false);
    },
  };
}
