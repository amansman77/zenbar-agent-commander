// Message input for an existing task session (follow-up turns).

export function SessionComposer({
  value,
  disabled,
  pending,
  onChange,
  onSend
}: {
  value: string;
  disabled: boolean;
  pending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const canSend = value.trim().length > 0 && !disabled && !pending;
  return (
    <section className="session-composer">
      <textarea
        aria-label="Session follow-up"
        className="session-composer-input"
        placeholder="Ask the agent about this run..."
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || pending}
      />
      <div className="session-composer-actions">
        <button type="button" onClick={onSend} disabled={!canSend}>
          {pending ? "Sending..." : "Send"}
        </button>
      </div>
    </section>
  );
}
