// List of a project's prompt pipelines.

import type {
  ProjectPipeline,
  ProjectPrompt
} from "@zenbar/shared";

export function ProjectPipelineList({
  pipelines,
  prompts,
  isLoading,
  hasProject,
  deletePending,
  onEdit,
  onDelete,
}: {
  pipelines: ProjectPipeline[] | undefined;
  prompts: ProjectPrompt[] | undefined;
  isLoading: boolean;
  hasProject: boolean;
  deletePending: boolean;
  onEdit: (pipeline: ProjectPipeline) => void;
  onDelete: (pipeline: ProjectPipeline) => void;
}) {
  if (!hasProject) {
    return <p className="empty-state">프로젝트를 먼저 선택하세요.</p>;
  }
  if (isLoading) {
    return <p className="empty-state">Loading...</p>;
  }
  if (!pipelines?.length) {
    return <p className="empty-state">저장된 파이프라인이 없습니다. 아래에서 프롬프트를 골라 순서대로 추가하세요.</p>;
  }
  const titleFor = (promptId: string) => prompts?.find((p) => p.id === promptId)?.title ?? "(삭제된 프롬프트)";
  return (
    <>
      {pipelines.map((pipeline) => (
        <div key={pipeline.id} className="list-item">
          <div>
            <strong>{pipeline.name}</strong>
            <p className="item-secondary" style={{ marginTop: "4px" }}>
              {pipeline.prompt_ids.map((id, index) => `${index + 1}. ${titleFor(id)}`).join(" → ")}
            </p>
          </div>
          <div className="inline-actions" style={{ marginTop: "8px" }}>
            <button
              type="button"
              className="secondary"
              style={{ fontSize: "0.75rem", padding: "4px 10px" }}
              onClick={() => onEdit(pipeline)}
            >
              편집
            </button>
            <button
              type="button"
              className="secondary"
              style={{ fontSize: "0.75rem", padding: "4px 10px" }}
              disabled={deletePending}
              onClick={() => onDelete(pipeline)}
            >
              삭제
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
