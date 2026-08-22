// Create/edit form for a single saved prompt.

export function ProjectPromptForm({
  title,
  setTitle,
  content,
  setContent,
  onSubmit,
  onCancel,
  canSubmit,
  isSaving,
}: {
  title: string;
  setTitle: (value: string) => void;
  content: string;
  setContent: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  canSubmit: boolean;
  isSaving: boolean;
}) {
  return (
    <form
      className="panel form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 버그 트리아지" />
      </label>
      <label>
        Prompt
        <textarea
          className="task-prompt-input"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="자주 쓰는 프롬프트 내용을 입력하세요."
        />
      </label>
      <button type="submit" disabled={!canSubmit || isSaving}>
        {isSaving ? "저장 중..." : "저장"}
      </button>
      <button type="button" className="secondary" onClick={onCancel}>
        취소
      </button>
    </form>
  );
}
