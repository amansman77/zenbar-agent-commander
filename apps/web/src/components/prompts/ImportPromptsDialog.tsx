// Imports prompt files from another project's repository as saved prompts.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ProjectPrompt,
  ProjectSummary
} from "@zenbar/shared";
import { api } from "../../api";

// Copies selected prompts from another project into the current one --
// requested after prompts turned out to be project-scoped with no way to
// reuse one written for a different project short of retyping it. Copies
// (creates new rows) rather than sharing/linking, matching how prompts
// already behave everywhere else (each is independently edited/deleted per
// project) -- no new "shared prompt" concept to reason about.
export function ImportPromptsDialog({
  currentProject,
  onClose,
  onImported,
}: {
  currentProject: ProjectSummary;
  onClose: () => void;
  onImported: () => void;
}) {
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const otherProjects = (projectsQuery.data ?? []).filter((p) => p.id !== currentProject.id);

  const sourcePromptsQuery = useQuery({
    queryKey: ["project-prompts", sourceProjectId || null],
    queryFn: () => api.listProjectPrompts(sourceProjectId),
    enabled: Boolean(sourceProjectId),
  });
  const sourcePrompts = sourcePromptsQuery.data ?? [];
  const selectedPrompts = sourcePrompts.filter((p) => selectedIds.includes(p.id));

  const importMutation = useMutation({
    mutationFn: async (prompts: ProjectPrompt[]) => {
      // Sequential, not Promise.all: these hit the same project's prompt
      // list with no server-side ordering guarantee otherwise, and a
      // partial failure partway through should still leave a clean,
      // predictable prefix imported rather than an unpredictable subset.
      for (const prompt of prompts) {
        await api.createProjectPrompt(currentProject.id, { title: prompt.title, content: prompt.content });
      }
    },
    onSuccess: () => {
      onImported();
      onClose();
    },
    onError: (err: Error) => alert(`프롬프트 가져오기 실패: ${err.message}`),
  });

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => (previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id]));
  };

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <label>
        가져올 프로젝트
        <select
          value={sourceProjectId}
          onChange={(event) => {
            setSourceProjectId(event.target.value);
            setSelectedIds([]);
          }}
        >
          <option value="">프로젝트 선택</option>
          {otherProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {sourceProjectId ? (
        sourcePromptsQuery.isLoading ? (
          <p className="empty-state">Loading...</p>
        ) : sourcePrompts.length === 0 ? (
          <p className="empty-state">이 프로젝트에는 저장된 프롬프트가 없습니다.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.4rem", maxHeight: "40vh", overflowY: "auto", minWidth: 0 }}>
            {sourcePrompts.map((prompt) => (
              <label
                key={prompt.id}
                className="list-item"
                style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(prompt.id)}
                  onChange={() => toggleSelected(prompt.id)}
                  style={{ marginTop: "3px", flexShrink: 0 }}
                />
                <div style={{ minWidth: 0 }}>
                  <strong>{prompt.title}</strong>
                  {/* Not .truncate (nowrap) -- a long single-line prompt
                      under nowrap can force this row's grid track wider
                      than the viewport instead of just clipping in place.
                      Line-clamped instead of a plain pre-wrap: a
                      multi-line prompt (real example: a 6-line credentials
                      block) could otherwise grow this row tall enough to
                      visually run into the next one. */}
                  <p
                    className="item-secondary"
                    style={{
                      marginTop: "2px",
                      whiteSpace: "pre-wrap",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden"
                    }}
                  >
                    {prompt.content}
                  </p>
                </div>
              </label>
            ))}
          </div>
        )
      ) : null}

      <div className="inline-actions">
        <button
          type="button"
          onClick={() => importMutation.mutate(selectedPrompts)}
          disabled={selectedPrompts.length === 0 || importMutation.isPending}
        >
          {importMutation.isPending ? "가져오는 중..." : `가져오기 (${selectedPrompts.length})`}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          취소
        </button>
      </div>
    </div>
  );
}
