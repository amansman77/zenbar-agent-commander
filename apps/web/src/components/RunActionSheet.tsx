// Bottom sheet confirming a run action (run again / retry) and its model choice.

import { useEffect, useState } from "react";
import type {
  ExecutionMode
} from "@zenbar/shared";
import type { RunExecutionAction } from "../lib/taskStatus";

export function RunActionSheet({
  open,
  action,
  defaultModel,
  defaultExecutionMode,
  models,
  onClose,
  onConfirm
}: {
  open: boolean;
  action: RunExecutionAction | null;
  defaultModel: string;
  defaultExecutionMode: ExecutionMode;
  models: string[];
  onClose: () => void;
  onConfirm: (config: { model: string; executionMode: ExecutionMode }) => void;
}) {
  const [model, setModel] = useState(defaultModel);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(defaultExecutionMode);

  useEffect(() => {
    if (!open) {
      return;
    }
    setModel(defaultModel);
    setExecutionMode(defaultExecutionMode);
  }, [open, defaultModel, defaultExecutionMode]);

  useEffect(() => {
    if (!models.includes(model)) {
      setModel(models[0] ?? "");
    }
  }, [model, models]);

  if (!open || !action) {
    return null;
  }

  const confirmLabel = action === "run_again" ? "Run again" : "Retry";
  const canConfirm = Boolean(model);

  return (
    <div className="bottom-sheet-backdrop" onClick={onClose}>
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label={confirmLabel} onClick={(event) => event.stopPropagation()}>
        <div className="bottom-sheet-header">
          <h3>{confirmLabel}</h3>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="bottom-sheet-list">
          <label className="retry-model-control retry-model-control-mobile">
            Model
            <select aria-label="Retry model" value={model} onChange={(event) => setModel(event.target.value)} disabled={models.length === 0}>
              {models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="retry-model-control retry-model-control-mobile">
            Execution mode
            <div className="segmented-control two-up" role="group" aria-label="Execution mode">
              <button
                type="button"
                className={`segment-button ${executionMode === "execute" ? "active" : ""}`}
                onClick={() => setExecutionMode("execute")}
              >
                Execute
              </button>
              <button
                type="button"
                className={`segment-button ${executionMode === "plan" ? "active" : ""}`}
                onClick={() => setExecutionMode("plan")}
              >
                Plan
              </button>
            </div>
          </label>
          <button type="button" onClick={() => onConfirm({ model, executionMode })} disabled={!canConfirm}>
            Confirm {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
