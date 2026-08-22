// Builds a pipeline by ordering a project's saved prompts into steps.

import type {
  ProjectPrompt
} from "@zenbar/shared";

export function ProjectPipelineBuilder({
  prompts,
  selectedPromptIds,
  onTogglePrompt,
  name,
  setName,
  onSubmit,
  onCancel,
  canSave,
  isSaving,
  isEditing = false,
}: {
  prompts: ProjectPrompt[] | undefined;
  selectedPromptIds: string[];
  onTogglePrompt: (promptId: string) => void;
  name: string;
  setName: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  canSave: boolean;
  isSaving: boolean;
  isEditing?: boolean;
}) {
  return (
    <form
      className="panel form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSubmit();
      }}
    >
      <label>
        파이프라인 이름
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 이슈 대응 전체 흐름" />
      </label>
      <p className="item-secondary">프롬프트를 클릭한 순서대로 파이프라인이 만들어져요.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {!prompts?.length && <p className="empty-state">저장된 프롬프트가 없습니다. 먼저 프롬프트를 추가하세요.</p>}
        {prompts?.map((prompt) => {
          const order = selectedPromptIds.indexOf(prompt.id);
          const selected = order !== -1;
          return (
            <button
              type="button"
              key={prompt.id}
              onClick={() => onTogglePrompt(prompt.id)}
              className="list-item"
              style={{
                textAlign: "left",
                cursor: "pointer",
                border: selected ? "2px solid #0f3158" : undefined,
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: "22px",
                  height: "22px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.75rem",
                  background: selected ? "#0f3158" : "#e5e9f0",
                  color: selected ? "#fff" : "#5b6472",
                }}
              >
                {selected ? order + 1 : ""}
              </span>
              <strong>{prompt.title}</strong>
            </button>
          );
        })}
      </div>
      <button type="submit" disabled={!canSave || isSaving}>
        {isSaving ? "저장 중..." : isEditing ? "변경사항 저장" : "파이프라인 저장"}
      </button>
      <button type="button" className="secondary" onClick={onCancel}>
        취소
      </button>
    </form>
  );
}
