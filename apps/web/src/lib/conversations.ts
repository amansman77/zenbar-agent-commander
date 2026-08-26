// Groups the flat conversation list into per-project sections for the list screen.

import type {
  ConversationSummary
} from "@zenbar/shared";

export type ConversationGroup = { key: string; projectName: string | null; conversations: ConversationSummary[] };

export const COLLAPSED_CONVERSATION_GROUPS_KEY = "zenbar:collapsedConversationGroups";

// Which project groups are fully collapsed (header only, no conversation
// rows) -- persisted so it survives a reload. Reported live: with more
// projects accumulating over time, the conversation list became a long
// scroll of everyone's preview rows just to see which projects existed at
// all, and re-collapsing them by hand on every visit wasn't a real option.
export function loadCollapsedConversationGroups(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSED_CONVERSATION_GROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveCollapsedConversationGroups(collapsed: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COLLAPSED_CONVERSATION_GROUPS_KEY, JSON.stringify(collapsed));
}

export function groupConversationsByProject(conversations: ConversationSummary[]): ConversationGroup[] {
  // Conversations already arrive sorted by recency (updated_at desc), so
  // grouping by first-appearance order (rather than re-sorting) keeps that
  // property at the group level too: the project with the most recently
  // active conversation ends up as the first group, with no separate sort
  // step needed.
  const groups: ConversationGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const conv of conversations) {
    const key = conv.project_id ?? "__no_project__";
    let groupIndex = indexByKey.get(key);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      indexByKey.set(key, groupIndex);
      groups.push({ key, projectName: conv.project_name, conversations: [] });
    }
    groups[groupIndex].conversations.push(conv);
  }
  return groups;
}
