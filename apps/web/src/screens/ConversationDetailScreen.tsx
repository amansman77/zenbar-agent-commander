// The main working surface: one conversation's messages, its task's timeline,
// plan, diff and PR cards, and the compose bar that starts or follows up a task.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddConversationMessageRequest,
  ConversationDetail,
  ConversationMessageItem,
  ProjectPipeline,
  ProjectPrompt,
  RuntimeEngineOption,
  RuntimeProfileOption,
  RuntimeSkill
} from "@zenbar/shared";
import { api } from "../api";
import { UsageBadge } from "../components/Badges";
import { ConversationTranscript } from "../components/ConversationTranscript";
import type { MessageGroup } from "../components/ConversationTranscript";
import { useCloseOnOutsideClick } from "../hooks/useCloseOnOutsideClick";
import { useIsMobileBreakpoint } from "../hooks/useIsMobileBreakpoint";
import { USAGE_SUPPORTED_ENGINES, actor } from "../lib/constants";
import { ACTIVE_TASK_STATUSES } from "../lib/notifications";
import { extractFailureReason } from "../lib/taskEvents";

export function ConversationDetailScreen({
  conversationId,
  onBack,
  showBackButton = true,
}: {
  conversationId: string;
  // Called when this conversation should be left — either via the Back
  // button or because it was deleted. Desktop still needs it (to clear the
  // now-dangling selection) even though it renders no Back button.
  onBack: () => void;
  // Desktop keeps the conversation list visible beside the chat, so there
  // is nowhere to navigate "back" to.
  showBackButton?: boolean;
}) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobileBreakpoint();
  const [activeTab, setActiveTab] = useState<"chat" | "diff">("chat");
  const [diffExpanded, setDiffExpanded] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const skillMenuRef = useCloseOnOutsideClick(skillMenuOpen, setSkillMenuOpen);
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const promptMenuRef = useCloseOnOutsideClick(promptMenuOpen, setPromptMenuOpen);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [pipelineMenuOpen, setPipelineMenuOpen] = useState(false);
  const pipelineMenuRef = useCloseOnOutsideClick(pipelineMenuOpen, setPipelineMenuOpen);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const deleteConversationMutation = useMutation({
    mutationFn: () => api.deleteConversation(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onBack();
    },
  });

  const { data: conversation, isLoading } = useQuery<ConversationDetail>({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
    refetchInterval: (query) => {
      const data = query.state.data as ConversationDetail | undefined;
      const taskStatus = data?.task_status ?? null;
      return taskStatus && ACTIVE_TASK_STATUSES.includes(taskStatus) ? 1500 : 3000;
    },
  });
  const taskStarted = conversation?.task_id != null;
  const isTaskActive = conversation?.task_status != null && ACTIVE_TASK_STATUSES.includes(conversation.task_status);

  const { data: skillsData } = useQuery({
    queryKey: ["runtime-skills"],
    queryFn: () => api.listRuntimeSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const skills: RuntimeSkill[] = skillsData?.skills ?? [];

  const projectId = conversation?.project_id ?? null;
  const { data: promptsData } = useQuery({
    queryKey: ["project-prompts", projectId],
    queryFn: () => api.listProjectPrompts(projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
  const savedPrompts: ProjectPrompt[] = promptsData ?? [];

  const { data: pipelinesData } = useQuery({
    queryKey: ["project-pipelines", projectId],
    queryFn: () => api.listProjectPipelines(projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
  const availablePipelines: ProjectPipeline[] = pipelinesData ?? [];

  const taskId = conversation?.task_id ?? null;
  const { data: diffData, refetch: refetchDiff } = useQuery({
    queryKey: ["conv-diff", taskId],
    queryFn: () => api.getDiff(taskId!),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });

  // A conversation can genuinely have more than one PR/MR (retries, several
  // follow-ups each opening their own) -- every one mentioned shows up,
  // most recently mentioned first (see pr_info.py's find_all_pr_or_mr_urls).
  // They only show up once the agent mentions them in a message (there's
  // no structured field for it), so this is enabled the same way the diff
  // is and re-checked periodically rather than depending on some explicit
  // "PR opened" signal.
  const { data: prInfos } = useQuery({
    queryKey: ["conv-pr-info", conversationId],
    queryFn: () => api.getConversationPrInfo(conversationId),
    enabled: Boolean(taskId),
    staleTime: 30_000,
    refetchInterval: isTaskActive ? 15_000 : false,
  });

  const { data: enginesData } = useQuery({
    queryKey: ["runtime-engines"],
    queryFn: () => api.listRuntimeEngines(),
    staleTime: 5 * 60 * 1000,
  });
  const availableEngines: RuntimeEngineOption[] = enginesData?.engines ?? [];
  const defaultEngine = enginesData?.default_engine ?? null;
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null);
  const effectiveEngine = selectedEngine ?? defaultEngine;
  // Once a task exists, its own engine is authoritative over whatever's
  // currently selected in the (now-hidden) engine picker. Tasks created
  // before per-task engine selection existed (or without one explicitly
  // picked) store "" for task_engine, not "codex" -- `||` (not `??`)
  // matches the same "falsy engine means the default engine" convention
  // the backend already applies (see TaskOrchestrator._adapter_for).
  // Shared by usage, the model picker, and the profiles gate below, all of
  // which need the task's *real* engine once one exists, not just
  // whatever's left over in the (by then hidden) pre-task engine picker.
  const activeEngine = taskStarted ? conversation?.task_engine || defaultEngine : effectiveEngine;
  // Profiles read ~/.codex/*.config.toml — a Codex-only concept, meaningless for other engines.
  const engineSupportsProfiles = activeEngine == null || activeEngine === "codex";

  // Account-level rate-limit status -- Codex, Antigravity, and Claude all
  // support this (see each adapter's get_usage); Grok doesn't expose an
  // equivalent anywhere, so its /runtime/usage calls are simply never made.
  const usageEngine = activeEngine;
  const usageEngineSupported = usageEngine != null && USAGE_SUPPORTED_ENGINES.includes(usageEngine);
  const { data: usageData } = useQuery({
    queryKey: ["runtime-usage", usageEngine],
    queryFn: () => api.getRuntimeUsage(usageEngine!),
    enabled: usageEngineSupported,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const usageInfo = usageEngineSupported ? usageData?.usage ?? null : null;

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ["runtime-models", activeEngine],
    queryFn: () => api.listRuntimeModels(activeEngine),
    staleTime: 0,
  });
  const availableModels: string[] = (modelsData?.models ?? [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter((id) => id !== "default");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const { data: profilesData } = useQuery({
    queryKey: ["runtime-profiles"],
    queryFn: () => api.listRuntimeProfiles(),
    enabled: engineSupportsProfiles,
    staleTime: 5 * 60 * 1000,
  });
  const availableProfiles: RuntimeProfileOption[] = engineSupportsProfiles ? profilesData?.profiles ?? [] : [];
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  // Once a task exists, its own profile (not whatever's left over in the
  // pre-task picker) is what actually governs whether the model is locked
  // -- needed now that the model picker stays interactive for a follow-up
  // (see modelToUse in handleSend below), not just before the first send.
  const activeProfileId = taskStarted ? conversation?.task_profile ?? null : selectedProfile;
  const selectedProfileOption = availableProfiles.find((p) => p.id === activeProfileId) ?? null;
  const profileControlsModel = Boolean(selectedProfileOption?.model);
  const effectiveModel = conversation?.task_model ?? selectedModel ?? availableModels[0] ?? null;

  const isWaitingApproval = conversation?.task_status === "waiting_result_approval";
  const isTaskFailed = conversation?.task_status === "failed";
  const isTaskStopped = conversation?.task_status === "stopped";

  const { data: taskEventsData } = useQuery({
    queryKey: ["conv-task-events", taskId],
    queryFn: () => api.getEvents(taskId!),
    enabled: Boolean(taskId) && isTaskFailed,
    staleTime: 10_000,
  });
  const failureReason = isTaskFailed ? extractFailureReason(taskEventsData) : null;

  const retryTaskMutation = useMutation({
    mutationFn: () => api.retryTask(taskId!, { actor: "user" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: Error) => {
      alert(`재시도 실패: ${err.message}`);
    },
  });

  const approveTaskMutation = useMutation({
    mutationFn: () => api.approveTask(conversation!.task_id!, { actor: "user" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: Error) => {
      alert(`승인 실패: ${err.message}`);
    },
  });

  const stopTaskMutation = useMutation({
    mutationFn: () => api.stopTask(conversation!.task_id!, { actor: "user" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: Error) => {
      alert(`중지 실패: ${err.message}`);
    },
  });

  const addMessageMutation = useMutation({
    mutationFn: (payload: AddConversationMessageRequest) =>
      api.addConversationMessage(conversationId, payload),
    onSuccess: (updated) => {
      setInput("");
      setSelectedSkill(null);
      // A model switch is only meant to apply once (this and every turn
      // after it, per the backend) -- not keep resending the same explicit
      // override on every future follow-up. effectiveModel already prefers
      // conversation.task_model (which `updated` just refreshed) over this,
      // so clearing it doesn't lose anything the picker still needs to show.
      setSelectedModel(null);
      queryClient.setQueryData(["conversation", conversationId], updated);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err: Error) => {
      alert(`메시지 전송 실패: ${err.message}`);
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages.length]);

  useEffect(() => {
    if (activeTab === "chat") {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [activeTab]);

  useEffect(() => {
    // Model/profile catalogs are engine-specific; a pick from the previous
    // engine is meaningless (or invalid) after switching.
    setSelectedModel(null);
    setSelectedProfile(null);
  }, [effectiveEngine]);

  const selectedSkillName = skills.find((s) => s.id === selectedSkill)?.name ?? null;
  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
    s.id.toLowerCase().includes(skillSearch.toLowerCase())
  );

  // Codex can emit several assistant messages while working a single turn
  // (status updates, intermediate notes) before the actual final answer.
  // These all land as separate ConversationMessage rows with no marker
  // distinguishing them, so group each run of consecutive assistant
  // messages and treat only the last one as the prominent "final answer" —
  // the earlier ones in the run render collapsed, similar to the Codex
  // app's own "thinking" section.
  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];
    let run: ConversationMessageItem[] = [];
    const flushRun = () => {
      if (run.length > 0) {
        groups.push({ kind: "assistant", intermediates: run.slice(0, -1), final: run[run.length - 1] });
        run = [];
      }
    };
    for (const message of conversation?.messages ?? []) {
      if (message.role === "assistant") {
        run.push(message);
      } else {
        flushRun();
        groups.push({ kind: "user", message });
      }
    }
    flushRun();
    return groups;
  }, [conversation?.messages]);

  // Pipelines only make sense as the way a task *starts* -- the auto-advance
  // machinery (TaskOrchestrator._advance_pipeline_if_needed) drives a
  // freshly-created task through all its steps, so picking one only applies
  // before the first message.
  const canSendPipeline = Boolean(selectedPipelineId && !taskStarted);
  const selectedPipelineName = availablePipelines.find((p) => p.id === selectedPipelineId)?.name ?? null;
  const isSendDisabled = (!input.trim() && !canSendPipeline) || addMessageMutation.isPending || isTaskActive;

  const handleSend = () => {
    if (isSendDisabled) return;
    // A follow-up can switch the model for this and subsequent turns (same
    // session/workspace/history) -- but only when explicitly picked
    // (selectedModel set); when the user hasn't touched the picker, `null`
    // tells the backend "keep whatever this task is already using" rather
    // than silently re-sending availableModels[0], which could differ from
    // the model actually in use and switch it out from under the user on
    // every follow-up. A fresh task has no "keep as-is" to fall back to, so
    // it still needs a concrete pick.
    const modelToUse = profileControlsModel
      ? null
      : selectedModel || (taskStarted ? null : availableModels[0] || null);
    const profileToUse = taskStarted ? null : selectedProfile;
    const engineToUse = taskStarted ? null : selectedEngine;
    if (canSendPipeline) {
      // Typing is still optional here (a pipeline can start with nothing
      // typed, same as before), but anything typed is no longer thrown
      // away -- it's prepended to the first step's saved prompt on the
      // backend (see post_conversation_message), so a pipeline whose first
      // step is a generic template (e.g. "이슈를 확인하고 작업해줘") can
      // still be pointed at something specific (e.g. "이슈 #123") when
      // started, instead of always running the template verbatim.
      addMessageMutation.mutate({
        content: input.trim(),
        selected_skill: null,
        engine: engineToUse,
        model: null,
        profile: null,
        pipeline_id: selectedPipelineId,
      });
      setSelectedPipelineId(null);
      setInput("");
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) return;
    addMessageMutation.mutate({ content: trimmed, selected_skill: selectedSkill, engine: engineToUse, model: modelToUse, profile: profileToUse });
  };

  return (
    <section
      className="panel mobile-screen chat-screen"
      style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}
    >
      <div className="mobile-detail-control">
        <div className={showBackButton ? "mobile-detail-control-top" : "mobile-detail-control-top mobile-detail-control-top-no-back"}>
          {showBackButton ? (
            <button type="button" className="secondary mobile-back" onClick={onBack}>Back</button>
          ) : null}
          <div style={{ minWidth: 0 }}>
            <strong className="truncate" style={{ display: "block" }}>{conversation?.title ?? "Conversation"}</strong>
            {conversation?.project_name && (
              <span style={{ fontSize: "0.75rem", color: "var(--text-soft)" }}>{conversation.project_name}</span>
            )}
          </div>
          <button
            type="button"
            className="secondary"
            style={{ fontSize: "0.8rem", padding: "4px 10px", flexShrink: 0 }}
            disabled={deleteConversationMutation.isPending}
            onClick={() => deleteConversationMutation.mutate()}
            title="대화 삭제"
          >
            삭제
          </button>
        </div>
      </div>

      <ConversationTranscript
        conversationId={conversationId}
        conversation={conversation}
        isLoading={isLoading}
        messageGroups={messageGroups}
        messagesEndRef={messagesEndRef}
        activeTab={activeTab}
        diffData={diffData}
        diffExpanded={diffExpanded}
        setDiffExpanded={setDiffExpanded}
        prInfos={prInfos}
        isTaskActive={isTaskActive}
        isWaitingApproval={isWaitingApproval}
        isTaskFailed={isTaskFailed}
        isTaskStopped={isTaskStopped}
        failureReason={failureReason}
        approveTaskMutation={approveTaskMutation}
        stopTaskMutation={stopTaskMutation}
        retryTaskMutation={retryTaskMutation}
      />

      <div
        style={{
          borderTop: "1px solid var(--line)",
          background: "rgba(255,255,255,0.98)",
          paddingBottom: "calc(0px + env(safe-area-inset-bottom))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px 0", flexWrap: "wrap" }}>
          {conversation?.task_workspace_ref ? (
            <span
              title={`기본 브랜치: ${conversation.task_base_branch ?? "unknown"}`}
              style={{ fontSize: "0.73rem", color: "var(--text-soft)", whiteSpace: "nowrap" }}
            >
              ⎇ {conversation.task_workspace_ref}
              {conversation.task_base_branch && (
                <span style={{ opacity: 0.55 }}> ← {conversation.task_base_branch}</span>
              )}
            </span>
          ) : null}
          {taskStarted ? (
            conversation?.task_engine ? (
              <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }}>
                🧠 {availableEngines.find((e) => e.id === conversation.task_engine)?.label ?? conversation.task_engine}
              </span>
            ) : null
          ) : (
            availableEngines.length > 1 && (
              <label style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.73rem", color: "var(--text-soft)" }}>
                <span>🧠</span>
                <select
                  value={effectiveEngine ?? ""}
                  onChange={(e) => setSelectedEngine(e.target.value || null)}
                  title="AI engine"
                  style={{
                    fontSize: "0.73rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-soft)",
                    cursor: "pointer",
                    padding: 0,
                    outline: "none",
                    maxWidth: "140px",
                  }}
                >
                  {availableEngines.map((eng) => (
                    <option key={eng.id} value={eng.id}>{eng.label}</option>
                  ))}
                </select>
              </label>
            )
          )}
          {profileControlsModel ? (
            <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }} title="Model is set by the selected profile">
              ◎ {selectedProfileOption?.model}
            </span>
          ) : taskStarted && isTaskActive ? (
            // Genuinely mid-turn -- nothing to pick yet, since a follow-up
            // (where a model switch actually applies) can only be sent
            // once the current turn finishes.
            effectiveModel ? (
              <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }}>◎ {effectiveModel}</span>
            ) : null
          ) : modelsLoading ? (
            // Engines whose model list comes from a real CLI subprocess call
            // (e.g. Antigravity's `agy models`, ~3s wall time) leave this
            // spot empty for long enough after switching engines that it
            // reads as "this engine has no model picker" rather than
            // "still loading" -- reproduced live by switching the engine
            // dropdown and watching the selector vanish for several
            // seconds. Codex's own list resolves near-instantly, which is
            // why this was never noticed there.
            <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }}>◎ Loading models...</span>
          ) : (
            availableModels.length > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.73rem", color: "var(--text-soft)" }}>
                <span>◎</span>
                <select
                  // selectedModel (the user's own not-yet-sent pick) must
                  // win here, not just in handleSend's modelToUse --
                  // effectiveModel prioritizes conversation.task_model (the
                  // last-confirmed backend value) first, so picking a new
                  // option looked like it did nothing until a message was
                  // actually sent and the switch came back confirmed.
                  value={selectedModel ?? effectiveModel ?? availableModels[0]}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  // A finished task keeps this picker open (unlike engine/
                  // profile, which stay locked once a task exists) -- a
                  // follow-up sends this model for that and every turn
                  // after it, same session/workspace/history the whole way.
                  title={taskStarted ? "다음 메시지부터 이 모델이 적용됩니다" : undefined}
                  style={{
                    fontSize: "0.73rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-soft)",
                    cursor: "pointer",
                    padding: 0,
                    outline: "none",
                    maxWidth: "140px",
                  }}
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            )
          )}
          {taskStarted ? (
            conversation?.task_profile ? (
              <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }}>▤ {conversation.task_profile}</span>
            ) : null
          ) : (
            availableProfiles.length > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.73rem", color: "var(--text-soft)" }}>
                <span>▤</span>
                <select
                  value={selectedProfile ?? ""}
                  onChange={(e) => setSelectedProfile(e.target.value || null)}
                  title="Codex profile"
                  style={{
                    fontSize: "0.73rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-soft)",
                    cursor: "pointer",
                    padding: 0,
                    outline: "none",
                    maxWidth: "140px",
                  }}
                >
                  <option value="">No profile</option>
                  {availableProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.id}</option>
                  ))}
                </select>
              </label>
            )
          )}
          {usageInfo && (usageInfo.session || usageInfo.week) ? (
            <UsageBadge usage={usageInfo} style={{ fontSize: "0.73rem", color: "var(--text-soft)" }} />
          ) : null}
          {taskId && (
            <button
              type="button"
              onClick={() => { setActiveTab((t) => t === "chat" ? "diff" : "chat"); if (activeTab === "chat") refetchDiff(); }}
              style={{
                marginLeft: skills.length > 0 ? "0" : "auto",
                padding: "4px 12px",
                borderRadius: "14px",
                fontSize: "0.78rem",
                fontWeight: activeTab === "diff" ? 600 : 400,
                border: activeTab === "diff" ? "1.5px solid #0f3158" : "1.5px solid var(--line)",
                background: activeTab === "diff" ? "#0f3158" : "transparent",
                color: activeTab === "diff" ? "#fff" : "var(--text-soft)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {activeTab === "diff" ? "💬 대화" : "📄 변경사항"}
            </button>
          )}
          {skills.length > 0 && (
            <div ref={skillMenuRef} style={{ position: "relative", marginLeft: taskId ? "0" : "auto" }}>
              <button
                type="button"
                onClick={() => { setSkillMenuOpen((o) => !o); setSkillSearch(""); }}
              style={{
                padding: "4px 12px",
                borderRadius: "14px",
                fontSize: "0.78rem",
                fontWeight: selectedSkill ? 600 : 400,
                border: selectedSkill ? "1.5px solid #0f3158" : "1.5px solid var(--line)",
                background: selectedSkill ? "#0f3158" : "transparent",
                color: selectedSkill ? "#fff" : "var(--text-soft)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {selectedSkillName ? `⚡ ${selectedSkillName}` : "⚡ Auto"}
            </button>
            {skillMenuOpen && (
              <div style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                zIndex: 200,
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderRadius: "10px",
                boxShadow: "var(--shadow)",
                width: "260px",
                overflow: "hidden",
              }}>
                <div style={{ padding: "8px" }}>
                  <input
                    autoFocus
                    type="text"
                    placeholder="스킬 검색..."
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      borderRadius: "8px",
                      border: "1px solid var(--line)",
                      fontSize: "0.82rem",
                      background: "var(--panel-soft)",
                      color: "var(--text)",
                      outline: "none",
                    }}
                  />
                </div>
                <div style={{ maxHeight: "220px", overflowY: "auto" }}>
                  <button
                    type="button"
                    onClick={() => { setSelectedSkill(null); setSkillMenuOpen(false); }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 14px",
                      fontSize: "0.82rem",
                      background: !selectedSkill ? "var(--panel-soft)" : "transparent",
                      color: !selectedSkill ? "var(--primary)" : "var(--text)",
                      fontWeight: !selectedSkill ? 600 : 400,
                      border: "none",
                      borderRadius: 0,
                      cursor: "pointer",
                    }}
                  >
                    Auto
                  </button>
                  {filteredSkills.map((skill) => (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => { setSelectedSkill(skill.id); setSkillMenuOpen(false); }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 14px",
                        fontSize: "0.82rem",
                        background: selectedSkill === skill.id ? "var(--panel-soft)" : "transparent",
                        color: selectedSkill === skill.id ? "var(--primary)" : "var(--text)",
                        fontWeight: selectedSkill === skill.id ? 600 : 400,
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {skill.name}
                    </button>
                  ))}
                  {filteredSkills.length === 0 && (
                    <p style={{ padding: "8px 14px", fontSize: "0.8rem", color: "var(--text-soft)", margin: 0 }}>
                      검색 결과 없음
                    </p>
                  )}
                </div>
              </div>
            )}
            </div>
          )}
          {savedPrompts.length > 0 && (
            <div ref={promptMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setPromptMenuOpen((o) => !o)}
                title="저장된 프롬프트"
                style={{
                  padding: "4px 12px",
                  borderRadius: "14px",
                  fontSize: "0.78rem",
                  border: "1.5px solid var(--line)",
                  background: "transparent",
                  color: "var(--text-soft)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                📋 프롬프트
              </button>
              {promptMenuOpen && (
                <div style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 200,
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                  boxShadow: "var(--shadow)",
                  width: "260px",
                  maxHeight: "260px",
                  overflowY: "auto",
                }}>
                  {savedPrompts.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setInput(item.content);
                        setPromptMenuOpen(false);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 14px",
                        fontSize: "0.82rem",
                        background: "transparent",
                        color: "var(--text)",
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      <strong style={{ display: "block" }}>{item.title}</strong>
                      <span
                        className="item-secondary truncate"
                        style={{ display: "block", fontSize: "0.75rem" }}
                      >
                        {item.content}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!taskStarted && availablePipelines.length > 0 && (
            <div ref={pipelineMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setPipelineMenuOpen((o) => !o)}
                title="파이프라인 실행"
                style={{
                  padding: "4px 12px",
                  borderRadius: "14px",
                  fontSize: "0.78rem",
                  fontWeight: selectedPipelineId ? 600 : 400,
                  border: selectedPipelineId ? "1.5px solid #0f3158" : "1.5px solid var(--line)",
                  background: selectedPipelineId ? "#0f3158" : "transparent",
                  color: selectedPipelineId ? "#fff" : "var(--text-soft)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedPipelineName ? `🔗 ${selectedPipelineName}` : "🔗 파이프라인"}
              </button>
              {pipelineMenuOpen && (
                <div style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 200,
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                  boxShadow: "var(--shadow)",
                  width: "260px",
                  maxHeight: "260px",
                  overflowY: "auto",
                }}>
                  {selectedPipelineId && (
                    <button
                      type="button"
                      onClick={() => { setSelectedPipelineId(null); setPipelineMenuOpen(false); }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 14px",
                        fontSize: "0.82rem",
                        background: "var(--panel-soft)",
                        color: "var(--primary)",
                        fontWeight: 600,
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      선택 해제
                    </button>
                  )}
                  {availablePipelines.map((pipeline) => (
                    <button
                      key={pipeline.id}
                      type="button"
                      onClick={() => {
                        setSelectedPipelineId(pipeline.id);
                        setPipelineMenuOpen(false);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 14px",
                        fontSize: "0.82rem",
                        background: selectedPipelineId === pipeline.id ? "var(--panel-soft)" : "transparent",
                        color: selectedPipelineId === pipeline.id ? "var(--primary)" : "var(--text)",
                        fontWeight: selectedPipelineId === pipeline.id ? 600 : 400,
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      <strong style={{ display: "block" }}>{pipeline.name}</strong>
                      <span
                        className="item-secondary truncate"
                        style={{ display: "block", fontSize: "0.75rem" }}
                      >
                        {pipeline.prompt_ids.length}단계
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {selectedPipelineId && (
          <p className="item-secondary" style={{ padding: "0 12px", fontSize: "0.78rem" }}>
            🔗 "{selectedPipelineName}" 파이프라인이 선택됨 — 보내기를 누르면 전체 단계가 자동으로 순서대로 실행돼요. 아래에 이슈 번호 등을 적으면 1단계 프롬프트 앞에 함께 전달돼요.
          </p>
        )}
        <div style={{ display: "flex", gap: "8px", padding: "8px 12px" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isTaskActive
                ? "Codex is working..."
                : selectedPipelineId
                  ? "예: 이슈 #123 (1단계 프롬프트 앞에 함께 전달돼요, 비워둬도 돼요)"
                  : "메시지를 입력하세요..."
            }
            disabled={isTaskActive}
            style={{ flex: 1, minHeight: "44px", maxHeight: "120px", resize: "none", opacity: isTaskActive ? 0.5 : 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !isMobile) {
                e.preventDefault();
                handleSend();
              }
            }}
            // On mobile this pops the on-screen keyboard open the instant a
            // conversation is opened, covering the very messages the user
            // just came to read -- forcing a dismiss-then-scroll-back every
            // single time. Desktop has no on-screen keyboard to fight, so
            // autofocus-on-open is still the right default there.
            autoFocus={!isMobile}
          />
          <button
            onClick={handleSend}
            disabled={isSendDisabled}
            style={{ alignSelf: "flex-end", minHeight: "44px", padding: "0 16px" }}
          >
            {addMessageMutation.isPending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}
