// List of a project's saved prompts, with select/edit/delete.

import type {
  ProjectPrompt
} from "@zenbar/shared";

export function ProjectPromptList({
  prompts,
  isLoading,
  hasProject,
  deletePending,
  reorderPending,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  prompts: ProjectPrompt[] | undefined;
  isLoading: boolean;
  hasProject: boolean;
  deletePending: boolean;
  reorderPending: boolean;
  onEdit: (prompt: ProjectPrompt) => void;
  onDelete: (prompt: ProjectPrompt) => void;
  onMoveUp: (prompt: ProjectPrompt) => void;
  onMoveDown: (prompt: ProjectPrompt) => void;
}) {
  if (!hasProject) {
    return <p className="empty-state">프로젝트를 먼저 선택하세요.</p>;
  }
  if (isLoading) {
    return <p className="empty-state">Loading...</p>;
  }
  if (!prompts?.length) {
    return <p className="empty-state">저장된 프롬프트가 없습니다. 위 버튼으로 추가하세요.</p>;
  }
  return (
    <>
      {prompts.map((prompt, index) => (
        <div key={prompt.id} className="list-item">
          <div>
            <strong>{prompt.title}</strong>
            <p className="item-secondary" style={{ whiteSpace: "pre-wrap", marginTop: "4px" }}>
              {prompt.content}
            </p>
          </div>
          <div className="inline-actions" style={{ marginTop: "8px" }}>
            <button
              type="button"
              className="secondary"
              style={{ fontSize: "0.75rem", padding: "4px 8px" }}
              disabled={reorderPending || index === 0}
              onClick={() => onMoveUp(prompt)}
              title="위로 이동"
              aria-label="위로 이동"
            >
              ▲
            </button>
            <button
              type="button"
              className="secondary"
              style={{ fontSize: "0.75rem", padding: "4px 8px" }}
              disabled={reorderPending || index === prompts.length - 1}
              onClick={() => onMoveDown(prompt)}
              title="아래로 이동"
              aria-label="아래로 이동"
            >
              ▼
            </button>
            <button type="button" className="secondary" style={{ fontSize: "0.75rem", padding: "4px 10px" }} onClick={() => onEdit(prompt)}>
              편집
            </button>
            <button
              type="button"
              className="secondary"
              style={{ fontSize: "0.75rem", padding: "4px 10px" }}
              disabled={deletePending}
              onClick={() => onDelete(prompt)}
            >
              삭제
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
