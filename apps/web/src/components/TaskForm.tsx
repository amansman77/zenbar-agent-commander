// New-task form: prompt, engine, model, profile, reasoning effort, execution
// mode, skills and workspace type. The largest single input surface in the app.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CreateTaskRequest,
  ExecutionMode,
  ProjectPrompt,
  ProjectSummary,
  ReasoningEffort,
  RuntimeEngineOption,
  RuntimeModelOption,
  RuntimeProfileOption
} from "@zenbar/shared";
import { api } from "../api";
import { LAST_TASK_MODEL_KEY } from "../lib/constants";

export function TaskForm({
  project,
  isMobile,
  onCreate,
  onClose
}: {
  project: ProjectSummary | null;
  isMobile: boolean;
  onCreate: (payload: CreateTaskRequest) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [engine, setEngine] = useState("");

  const enginesQuery = useQuery({
    queryKey: ["runtime-engines"],
    queryFn: () => api.listRuntimeEngines(),
    staleTime: 5 * 60 * 1000,
  });
  const engines: RuntimeEngineOption[] = enginesQuery.data?.engines ?? [];
  const defaultEngine = enginesQuery.data?.default_engine ?? null;
  const effectiveEngine = engine || defaultEngine;
  const engineSupportsProfiles = effectiveEngine == null || effectiveEngine === "codex";

  const modelsQuery = useQuery({
    queryKey: ["runtime-models", effectiveEngine],
    queryFn: () => api.listRuntimeModels(effectiveEngine),
    staleTime: 0,
  });
  const models: RuntimeModelOption[] = modelsQuery.data?.models ?? [];
  const modelsLoading = modelsQuery.isLoading;
  const modelsError = modelsQuery.error instanceof Error ? modelsQuery.error.message : null;

  const profilesQuery = useQuery({
    queryKey: ["runtime-profiles"],
    queryFn: () => api.listRuntimeProfiles(),
    enabled: engineSupportsProfiles,
    staleTime: 5 * 60 * 1000,
  });
  const profiles: RuntimeProfileOption[] = engineSupportsProfiles ? profilesQuery.data?.profiles ?? [] : [];

  const [model, setModel] = useState("");
  const [profile, setProfile] = useState("");
  const selectedProfileOption = profiles.find((p) => p.id === profile) ?? null;
  const profileControlsModel = Boolean(selectedProfileOption?.model);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [viewportInset, setViewportInset] = useState(0);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const savedPromptsQuery = useQuery({
    queryKey: ["project-prompts", project?.id ?? null],
    queryFn: () => api.listProjectPrompts(project!.id),
    enabled: Boolean(project),
    staleTime: 60_000,
  });
  const savedPrompts: ProjectPrompt[] = savedPromptsQuery.data ?? [];

  // effectiveEngine also changes on *mount* (null while /runtime/engines is
  // in flight, then the real default) -- not a user-driven engine switch,
  // so it shouldn't clear a profile picked in that window. See the matching
  // guard in ConversationDetailScreen for the reproduction: a real task
  // silently started on the plain default engine instead of the profile
  // picked seconds earlier, with no visible sign the pick had been dropped.
  const isFirstEngineRender = useRef(true);
  useEffect(() => {
    if (isFirstEngineRender.current) {
      isFirstEngineRender.current = false;
      return;
    }
    setProfile("");
  }, [effectiveEngine]);

  useEffect(() => {
    const available = models.map((item) => item.id);
    if (available.length === 0) {
      setModel("");
      return;
    }
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(LAST_TASK_MODEL_KEY) ?? "" : "";
    setModel((previous) => {
      if (previous && available.includes(previous)) {
        return previous;
      }
      if (saved && available.includes(saved)) {
        return saved;
      }
      return "";
    });
  }, [models]);

  useEffect(() => {
    if (!isMobile || step !== 1) {
      return;
    }
    titleRef.current?.focus();
  }, [isMobile, step]);

  useEffect(() => {
    if (!isMobile || typeof window === "undefined" || !window.visualViewport) {
      return;
    }
    const viewport = window.visualViewport;
    const syncInset = () => {
      const heightDelta = window.innerHeight - viewport.height - viewport.offsetTop;
      setViewportInset(Math.max(0, Math.round(heightDelta)));
    };
    syncInset();
    viewport.addEventListener("resize", syncInset);
    viewport.addEventListener("scroll", syncInset);
    return () => {
      viewport.removeEventListener("resize", syncInset);
      viewport.removeEventListener("scroll", syncInset);
    };
  }, [isMobile]);

  useEffect(() => {
    setPromptExpanded(false);
  }, [step]);

  const submitTask = () => {
    if (!project) {
      return;
    }
    if (typeof window !== "undefined" && model && !profileControlsModel) {
      window.localStorage.setItem(LAST_TASK_MODEL_KEY, model);
    }
    onCreate({
      project_id: project.id,
      title,
      prompt,
      engine: engine || null,
      model: profileControlsModel ? (selectedProfileOption!.model as string) : model,
      profile: profile || null,
      reasoning_effort: reasoningEffort,
      execution_mode: executionMode,
      workspace_type: "worktree"
    });
  };

  const ensureFocusedInputVisible = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (typeof target.scrollIntoView !== "function") {
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const requiredFieldsFilled = title.trim().length > 0 && prompt.trim().length > 0;
  const canProceedStep1 = Boolean(project && requiredFieldsFilled);
  const modelReady = profileControlsModel || Boolean(model && models.length > 0 && !modelsLoading);
  const canProceedStep2 = Boolean(project && modelReady);
  const canSubmit = Boolean(project && modelReady);
  const promptPreview =
    prompt.length > 140
      ? `${prompt.slice(0, 140).replace(/\s+/g, " ").trimEnd()}...`
      : prompt.replace(/\s+/g, " ").trim();

  if (isMobile) {
    return (
      <form
        className="panel form-panel task-form-mobile"
        onSubmit={(event) => {
          event.preventDefault();
          if (step !== 3 || !canSubmit) {
            return;
          }
          submitTask();
        }}
      >
        <div className="mobile-task-flow">
          <div className="mobile-task-progress" aria-label={`Step ${step} of 3`}>
            <span className={step === 1 ? "active" : ""}>1. Basic Info</span>
            <span className={step === 2 ? "active" : ""}>2. Configuration</span>
            <span className={step === 3 ? "active" : ""}>3. Review</span>
          </div>

          {step === 1 ? (
            <section className="mobile-task-section">
              <label>
                Title
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onFocus={(event) => ensureFocusedInputVisible(event.target)}
                  enterKeyHint="next"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      promptRef.current?.focus();
                    }
                  }}
                  placeholder="Fix sitemap canonical"
                  disabled={!project}
                />
              </label>
              <label>
                Prompt
                <textarea
                  className="task-prompt-input"
                  ref={promptRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onFocus={(event) => ensureFocusedInputVisible(event.target)}
                  enterKeyHint="done"
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canProceedStep1) {
                      event.preventDefault();
                      setStep(2);
                    }
                  }}
                  placeholder="Analyze the repository and fix canonical tag generation."
                  disabled={!project}
                />
              </label>
              {savedPrompts.length > 0 ? (
                <label>
                  저장된 프롬프트
                  <select
                    aria-label="저장된 프롬프트"
                    value=""
                    onChange={(event) => {
                      const selected = savedPrompts.find((item) => item.id === event.target.value);
                      if (selected) setPrompt(selected.content);
                    }}
                    disabled={!project}
                  >
                    <option value="">불러오기...</option>
                    {savedPrompts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </section>
          ) : null}

          {step === 2 ? (
            <section className="mobile-task-section">
              {engines.length > 1 ? (
                <label>
                  Engine
                  <select
                    aria-label="Engine"
                    value={effectiveEngine ?? ""}
                    onChange={(event) => setEngine(event.target.value)}
                    disabled={!project}
                  >
                    {engines.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Execution mode
                <div className="segmented-control two-up" role="group" aria-label="Execution mode">
                  <button
                    type="button"
                    className={`segment-button ${executionMode === "execute" ? "active" : ""}`}
                    onClick={() => setExecutionMode("execute")}
                    disabled={!project}
                  >
                    Execute
                  </button>
                  <button
                    type="button"
                    className={`segment-button ${executionMode === "plan" ? "active" : ""}`}
                    onClick={() => setExecutionMode("plan")}
                    disabled={!project}
                  >
                    Plan
                  </button>
                </div>
              </label>
              <label>
                Reasoning effort
                <div className="segmented-control" role="group" aria-label="Reasoning effort">
                  <button
                    type="button"
                    className={`segment-button ${reasoningEffort === "low" ? "active" : ""}`}
                    onClick={() => setReasoningEffort("low")}
                    disabled={!project}
                  >
                    Low
                  </button>
                  <button
                    type="button"
                    className={`segment-button ${reasoningEffort === "medium" ? "active" : ""}`}
                    onClick={() => setReasoningEffort("medium")}
                    disabled={!project}
                  >
                    Medium
                  </button>
                  <button
                    type="button"
                    className={`segment-button ${reasoningEffort === "high" ? "active" : ""}`}
                    onClick={() => setReasoningEffort("high")}
                    disabled={!project}
                  >
                    High
                  </button>
                </div>
              </label>
              {profiles.length > 0 ? (
                <label>
                  Profile
                  <select
                    aria-label="Profile"
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                    disabled={!project}
                  >
                    <option value="">No profile</option>
                    {profiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {profileControlsModel ? (
                <label>
                  Model
                  <div className="model-picker-button" aria-label="Model" title="Model is set by the selected profile">
                    {selectedProfileOption?.model} (from profile)
                  </div>
                </label>
              ) : (
                <label>
                  Model
                  <button
                    type="button"
                    className="model-picker-button"
                    onClick={() => setModelSheetOpen(true)}
                    disabled={!project || modelsLoading}
                    aria-label="Model"
                  >
                    {model || (modelsLoading ? "Loading runtime models..." : "Select model")}
                  </button>
                </label>
              )}
              {modelsError ? <p role="alert">{modelsError}</p> : null}
              {executionMode === "plan" ? (
                <p>Plan mode checks Codex runtime collaboration capability and streams planning steps into the event log.</p>
              ) : null}
            </section>
          ) : null}

          {step === 3 ? (
            <section className="mobile-task-section">
              <div className="review-field">
                <span className="meta-label">Title</span>
                <strong className="break-value">{title || "-"}</strong>
              </div>
              <div className="review-field review-field-prompt">
                <span className="meta-label">Prompt</span>
                <p className={`review-prompt ${!promptExpanded ? "collapsed" : ""}`}>
                  {(promptExpanded ? prompt : promptPreview) || "-"}
                </p>
                {prompt.trim().length > 0 ? (
                  <button type="button" className="secondary review-expand-button" onClick={() => setPromptExpanded((previous) => !previous)}>
                    {promptExpanded ? "Collapse" : "Show full prompt"}
                  </button>
                ) : null}
              </div>
              {engines.length > 1 ? (
                <div className="review-field">
                  <span className="meta-label">Engine</span>
                  <strong>{engines.find((item) => item.id === effectiveEngine)?.label ?? effectiveEngine}</strong>
                </div>
              ) : null}
              <div className="review-field">
                <span className="meta-label">Execution mode</span>
                <strong>{executionMode}</strong>
              </div>
              <div className="review-field">
                <span className="meta-label">Reasoning effort</span>
                <strong>{reasoningEffort}</strong>
              </div>
              <div className="review-field">
                <span className="meta-label">Model</span>
                <strong className="break-value mono">
                  {(profileControlsModel ? selectedProfileOption?.model : model) || "-"}
                </strong>
              </div>
              {profiles.length > 0 ? (
                <div className="review-field">
                  <span className="meta-label">Profile</span>
                  <strong className="break-value mono">{profile || "-"}</strong>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {modelSheetOpen ? (
          <div className="bottom-sheet-backdrop" onClick={() => setModelSheetOpen(false)}>
            <div
              className="bottom-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Select model"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="bottom-sheet-header">
                <h3>Select model</h3>
                <button type="button" className="secondary" onClick={() => setModelSheetOpen(false)}>
                  Close
                </button>
              </div>
              <div className="bottom-sheet-list">
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`bottom-sheet-option ${model === item.id ? "active" : ""}`}
                    onClick={() => {
                      setModel(item.id);
                      setModelSheetOpen(false);
                    }}
                  >
                    {item.id}
                  </button>
                ))}
                {!modelsLoading && models.length === 0 ? <p className="empty-state">No runtime models available.</p> : null}
              </div>
            </div>
          </div>
        ) : null}

        <div className="mobile-task-sticky-cta" style={{ bottom: `${viewportInset}px` }}>
          {step === 1 ? (
            <button type="button" onClick={() => setStep(2)} disabled={!canProceedStep1}>
              Next
            </button>
          ) : null}
          {step === 2 ? (
            <>
              <button type="button" className="secondary" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" onClick={() => setStep(3)} disabled={!canProceedStep2}>
                Next
              </button>
            </>
          ) : null}
          {step === 3 ? (
            <button type="submit" disabled={!canSubmit}>
              Create Task
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <form
      className="panel form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        // The submit button is disabled while !canSubmit, but that only
        // blocks a click — pressing Enter in a text field (e.g. Title)
        // submits the form natively regardless of the button's disabled
        // state, which used to send an empty/not-yet-loaded model straight
        // to the API and get a 400 back. Guard here too, matching the
        // mobile step-wizard branch's `if (step !== 3 || !canSubmit) return`.
        if (!canSubmit) {
          return;
        }
        submitTask();
      }}
    >
      <div className="panel-header">
        <h2>Task Workspace</h2>
        <p>Create an isolated task workspace for the selected project.</p>
      </div>
      {engines.length > 1 ? (
        <label>
          Engine
          <select
            aria-label="Engine"
            value={effectiveEngine ?? ""}
            onChange={(event) => setEngine(event.target.value)}
            disabled={!project}
          >
            {engines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        Title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Fix sitemap canonical"
          disabled={!project}
        />
      </label>
      <label>
        Prompt
        <textarea
          className="task-prompt-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Analyze the repository and fix canonical tag generation."
          disabled={!project}
        />
      </label>
      {savedPrompts.length > 0 ? (
        <label>
          저장된 프롬프트
          <select
            aria-label="저장된 프롬프트"
            value=""
            onChange={(event) => {
              const selected = savedPrompts.find((item) => item.id === event.target.value);
              if (selected) setPrompt(selected.content);
            }}
            disabled={!project}
          >
            <option value="">불러오기...</option>
            {savedPrompts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        Execution mode
        <select
          aria-label="Execution mode"
          value={executionMode}
          onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)}
          disabled={!project}
        >
          <option value="execute">Execute</option>
          <option value="plan">Plan</option>
        </select>
      </label>
      <label>
        Reasoning effort
        <select
          aria-label="Reasoning effort"
          value={reasoningEffort}
          onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
          disabled={!project}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      {profiles.length > 0 ? (
        <label>
          Profile
          <select aria-label="Profile" value={profile} onChange={(event) => setProfile(event.target.value)} disabled={!project}>
            <option value="">No profile</option>
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {profileControlsModel ? (
        <label>
          Model
          <input aria-label="Model" value={`${selectedProfileOption?.model} (from profile)`} disabled readOnly />
        </label>
      ) : (
        <label>
          Model
          <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} disabled={!project || modelsLoading}>
            <option value="">Select model</option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {modelsLoading ? <p>Loading runtime models...</p> : null}
      {modelsError ? <p role="alert">{modelsError}</p> : null}
      {executionMode === "plan" ? (
        <p>Plan mode checks Codex runtime collaboration capability and streams planning steps into the event log.</p>
      ) : null}
      <button type="submit" disabled={!canSubmit}>
        Create task
      </button>
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
    </form>
  );
}
