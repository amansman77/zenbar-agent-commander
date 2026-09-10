import type { GlobalPrompt, ProjectPrompt } from "@zenbar/shared";

export type AnySavedPrompt = ProjectPrompt | GlobalPrompt;

/**
 * Merge global prompts first, then project-scoped prompts.
 * Global prompts (e.g. a reusable "refactor this" template) first, then
 * this project's own -- reused-everywhere prompts are the ones worth
 * seeing before scrolling past a long project-specific list.
 */
export function mergeSavedPrompts(
  globalPrompts: GlobalPrompt[] = [],
  projectPrompts: ProjectPrompt[] = []
): AnySavedPrompt[] {
  return [...globalPrompts, ...projectPrompts];
}

/**
 * Build a set of global prompt IDs for badge/source classification.
 * Membership check by id rather than a ProjectPrompt/GlobalPrompt type
 * guard: GlobalPrompt's fields are a structural subset of ProjectPrompt's
 * (everything but project_id).
 */
export function getGlobalPromptIdSet(globalPrompts: GlobalPrompt[] = []): Set<string> {
  return new Set(globalPrompts.map((item) => item.id));
}
