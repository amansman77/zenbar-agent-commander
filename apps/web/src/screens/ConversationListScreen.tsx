// Home screen: conversations grouped by project, plus new-conversation entry.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ConversationSummary,
  ProjectSummary
} from "@zenbar/shared";
import { api } from "../api";
import { CONVERSATION_GROUP_PREVIEW_COUNT } from "../lib/constants";
import {
  groupConversationsByProject,
  loadCollapsedConversationGroups,
  saveCollapsedConversationGroups,
} from "../lib/conversations";

export function ConversationListScreen({
  conversations,
  conversationCounts,
  projects,
  isLoading,
  selectedConversationId,
  onSelect,
  onCreate,
  onDelete,
  onManageProjects,
}: {
  // The default-visible preview (server-side capped per project, see
  // list_conversations' own docstring) -- NOT the full set, so
  // group.conversations.length here is only accurate up to the preview
  // cutoff. conversationCounts (keyed by project_id, "__no_project__" for
  // none) carries each project's true total for the "더보기 (N)" label.
  conversations: ConversationSummary[];
  conversationCounts: Record<string, number>;
  projects: ProjectSummary[];
  isLoading: boolean;
  // Only meaningfully visible on desktop, where the list stays on screen
  // next to the detail panel -- mobile unmounts this screen the moment a
  // conversation opens, so there's nothing to highlight there. Reported
  // live: with no highlight at all, there was no way to tell which
  // conversation the open detail panel actually belonged to.
  selectedConversationId?: string | null;
  onSelect: (id: string) => void;
  onCreate: (projectId: string) => void;
  onDelete: (id: string) => void;
  // Omitted on desktop, which reaches projects via its own view switcher.
  onManageProjects?: () => void;
}) {
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // Whether a project's whole group (header + rows) is collapsed down to
  // just the header -- persisted (unlike expandedGroups' preview/full
  // toggle, which is fine resetting each visit) so it survives a reload.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(loadCollapsedConversationGroups);

  // Expanding any single group needs that project's full conversation
  // list, which the preview response doesn't carry -- fetched once,
  // covering every project, rather than adding one query per expanded
  // group (a user who expands two groups shouldn't pay for two separate
  // full-list round trips when one already has everything).
  const anyExpanded = Object.values(expandedGroups).some(Boolean);
  const fullConversationsQuery = useQuery({
    queryKey: ["conversations", "full"],
    queryFn: () => api.listConversations(),
    enabled: anyExpanded,
    staleTime: 30_000
  });
  const effectiveConversations =
    anyExpanded && fullConversationsQuery.data ? fullConversationsQuery.data : conversations;
  const groups = useMemo(() => groupConversationsByProject(effectiveConversations), [effectiveConversations]);

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveCollapsedConversationGroups(next);
      return next;
    });
  };

  const allGroupsCollapsed = groups.length > 0 && groups.every((group) => collapsedGroups[group.key]);
  const toggleAllGroups = () => {
    const next: Record<string, boolean> = {};
    for (const group of groups) {
      next[group.key] = !allGroupsCollapsed;
    }
    setCollapsedGroups(next);
    saveCollapsedConversationGroups(next);
  };

  return (
    <section className="panel mobile-screen">
      <div className="panel-header">
        <div className="row-header">
          <h2>Conversations</h2>
          <div style={{ display: "flex", gap: "8px" }}>
            {groups.length > 0 ? (
              <button
                type="button"
                className="secondary"
                onClick={toggleAllGroups}
                style={{ fontSize: "0.8rem", padding: "4px 10px" }}
              >
                {allGroupsCollapsed ? "모두 펼치기" : "모두 접기"}
              </button>
            ) : null}
            {onManageProjects ? (
              <button type="button" className="secondary" onClick={onManageProjects} style={{ fontSize: "0.8rem", padding: "4px 10px" }}>Projects</button>
            ) : null}
            <button type="button" onClick={() => setProjectSheetOpen(true)}>+</button>
          </div>
        </div>
      </div>
      <div className="panel-scroll">
        {isLoading && <p className="empty-state">Loading...</p>}
        {!isLoading && conversations.length === 0 && (
          <p className="empty-state">No conversations yet. Tap + to start.</p>
        )}
        {groups.map((group) => {
          const isExpanded = Boolean(expandedGroups[group.key]);
          const visibleConversations = isExpanded
            ? group.conversations
            : group.conversations.slice(0, CONVERSATION_GROUP_PREVIEW_COUNT);
          // group.conversations.length is only the true total once
          // effectiveConversations has switched to the full list (i.e.
          // once anyExpanded); before that it's just the preview count, so
          // conversationCounts is the source of truth for how many are
          // actually hidden.
          const totalForGroup = conversationCounts[group.key] ?? group.conversations.length;
          const hiddenCount = isExpanded ? 0 : Math.max(0, totalForGroup - visibleConversations.length);
          const isCollapsed = Boolean(collapsedGroups[group.key]);
          return (
            <div key={group.key}>
              <button
                type="button"
                className="conversation-group-header conversation-group-header-button"
                onClick={() => toggleGroupCollapsed(group.key)}
                aria-expanded={!isCollapsed}
              >
                <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                <span>{group.projectName ?? "프로젝트 없음"}</span>
              </button>
              {!isCollapsed && visibleConversations.map((conv) => (
                // position: relative wrapper + an absolutely-positioned
                // delete button lets it sit inside the card's own top-right
                // corner (matching the header bell's now-established
                // convention) without nesting a <button> inside the row's
                // own <button> -- invalid HTML, and would fire both click
                // handlers on every delete tap. They're DOM siblings that
                // visually overlap instead; the later one (delete) simply
                // paints on top and owns that corner's clicks.
                <div key={conv.id} style={{ position: "relative" }}>
                  <button
                    className={conv.id === selectedConversationId ? "list-item active" : "list-item"}
                    style={{ width: "100%" }}
                    onClick={() => onSelect(conv.id)}
                  >
                    <div className="list-row">
                      <strong className="truncate conversation-title">{conv.title}</strong>
                    </div>
                    {conv.last_message && (
                      <span className="item-secondary truncate conversation-preview">{conv.last_message}</span>
                    )}
                    <span className="item-secondary conversation-time">
                      {new Date(conv.updated_at).toLocaleString()}
                    </span>
                  </button>
                  <button
                    className="icon-button conversation-delete-button"
                    onClick={() => onDelete(conv.id)}
                    title="대화 삭제"
                    aria-label="대화 삭제"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                </div>
              ))}
              {!isCollapsed && hiddenCount > 0 ? (
                <button
                  type="button"
                  className="secondary conversation-group-more-button"
                  onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.key]: true }))}
                >
                  더보기 ({hiddenCount})
                </button>
              ) : null}
              {!isCollapsed && isExpanded && totalForGroup > CONVERSATION_GROUP_PREVIEW_COUNT ? (
                <button
                  type="button"
                  className="secondary conversation-group-more-button"
                  onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.key]: false }))}
                >
                  접기
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {projectSheetOpen && (
        <div className="bottom-sheet-backdrop" onClick={() => setProjectSheetOpen(false)}>
          <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="bottom-sheet-header">
              <h3>프로젝트 선택</h3>
              <button className="secondary" onClick={() => setProjectSheetOpen(false)}>✕</button>
            </div>
            <div className="bottom-sheet-list">
              {projects.length === 0 && (
                <p className="empty-state">No projects yet. Add a project first.</p>
              )}
              {projects.map((project) => (
                <button
                  key={project.id}
                  className="bottom-sheet-option"
                  onClick={() => {
                    setProjectSheetOpen(false);
                    onCreate(project.id);
                  }}
                >
                  <strong>{project.name}</strong>
                  <span style={{ display: "block", fontSize: "0.78rem", opacity: 0.7, marginTop: "2px" }}>
                    {project.repo_path}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
