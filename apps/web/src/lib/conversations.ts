// Groups the flat conversation list into per-project sections for the list screen.

import type {
  ConversationSummary
} from "@zenbar/shared";

export type ConversationGroup = { key: string; projectName: string | null; conversations: ConversationSummary[] };

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
