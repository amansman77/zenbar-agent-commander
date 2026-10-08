// The conversation header's title, renamable in place: a pencil button swaps
// it for an input; Enter or leaving the field saves, Escape cancels.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function ConversationTitleEditor({
  title,
  isSaving,
  onRename,
}: {
  title: string;
  isSaving: boolean;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and Escape end the edit by unmounting the input, and some browsers
  // fire blur on the way out. Without this, that blur would save a second
  // time, or save right after Escape had cancelled.
  const finishedRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    setDraft(title);
    finishedRef.current = false;
    setEditing(true);
  };

  const finish = (save: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setEditing(false);
    const next = draft.trim();
    // A blank or unchanged title is a cancel, not a request: the API would
    // reject a blank one anyway, and an unchanged one is a pointless write.
    if (save && next && next !== title) onRename(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter while a Korean IME is still composing commits the syllable, not
    // the field; saving then would cut off the last character typed.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="conversation-title-input"
        aria-label="대화 제목"
        value={draft}
        maxLength={255}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        autoFocus
      />
    );
  }

  return (
    <span className="conversation-title-row">
      <strong className="truncate">{title}</strong>
      <button
        type="button"
        className="icon-button conversation-rename-button"
        onClick={startEditing}
        disabled={isSaving}
        title="제목 변경"
        aria-label="제목 변경"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      </button>
    </span>
  );
}
