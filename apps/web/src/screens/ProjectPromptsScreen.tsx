// Prompts + pipelines management, as a full mobile screen and as a desktop modal.

import type {
  ProjectSummary
} from "@zenbar/shared";
import { Modal } from "../components/Modal";
import { useProjectPromptsWorkspace } from "../hooks/useProjectPromptsWorkspace";

export function ProjectPromptsScreen({
  project,
  onBack,
}: {
  project: ProjectSummary | null;
  onBack: () => void;
}) {
  const w = useProjectPromptsWorkspace(project);

  return (
    <section className="panel mobile-screen">
      <div className="panel-header">
        <div className="row-header">
          <div className="mobile-title-row" style={{ minWidth: 0 }}>
            <button type="button" className="secondary mobile-back" onClick={onBack}>
              Back
            </button>
            <h2 className="truncate" style={{ minWidth: 0 }}>
              {project
                ? `${project.name} ${w.tab === "prompts" ? "프롬프트" : w.tab === "global" ? "전역 프롬프트" : "파이프라인"}`
                : "Prompts"}
            </h2>
          </div>
        </div>
        {/* Tabs and action buttons each get their own row rather than
            sharing one -- with 가져오기 added alongside +Add, four buttons
            together no longer fit a mobile-width row without wrapping
            (previously just the two tabs, or just the two actions, fit
            fine on their own; it was specifically all four at once that
            didn't). */}
        <div className="inline-actions" style={{ marginTop: "8px" }}>{w.tabButtons}</div>
        <div className="inline-actions" style={{ marginTop: "8px" }}>
          {w.importButton}
          {w.addButton({ prompt: "+ Add", pipeline: "+ New" })}
        </div>
      </div>
      <div className="panel-scroll">{w.list}</div>

      <Modal title={w.promptFormTitle} open={w.activePromptEditor.formOpen} onClose={w.activePromptEditor.closeForm}>
        {w.promptForm}
      </Modal>

      <Modal title={w.pipelineFormTitle} open={w.pl.builderOpen} onClose={w.pl.closeBuilder}>
        {w.pipelineBuilder}
      </Modal>

      <Modal title="다른 프로젝트에서 가져오기" open={w.importOpen} onClose={w.closeImport}>
        {w.importDialog}
      </Modal>
    </section>
  );
}

export function ProjectPromptsModal({
  project,
  open,
  onClose,
}: {
  project: ProjectSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  const w = useProjectPromptsWorkspace(project);

  // A modal can't usefully nest another modal, so unlike the mobile screen
  // the editors (and the import dialog) replace the list inline here and
  // the modal's own title doubles as the editor's title.
  const modalTitle = w.activePromptEditor.formOpen
    ? w.promptFormTitle
    : w.pl.builderOpen
      ? w.pipelineFormTitle
      : w.importOpen
        ? "다른 프로젝트에서 가져오기"
        : project
          ? `${project.name} ${w.tab === "prompts" ? "Prompts" : w.tab === "global" ? "전역 프롬프트" : "Pipelines"}`
          : "Prompts";

  return (
    <Modal
      title={modalTitle}
      open={open}
      onClose={() => {
        w.closeAll();
        onClose();
      }}
    >
      {w.activePromptEditor.formOpen ? (
        w.promptForm
      ) : w.pl.builderOpen ? (
        w.pipelineBuilder
      ) : w.importOpen ? (
        w.importDialog
      ) : (
        <>
          <div className="inline-actions" style={{ marginBottom: "0.6rem" }}>{w.tabButtons}</div>
          <div className="inline-actions" style={{ marginBottom: "0.6rem" }}>
            {w.importButton}
            {w.addButton({ prompt: "+ Add prompt", pipeline: "+ New pipeline" })}
          </div>
          <div className="panel-scroll" style={{ maxHeight: "50vh" }}>
            {w.list}
          </div>
        </>
      )}
    </Modal>
  );
}
