// Saved-prompt queries for task forms and compose bars.
// Merges global prompts with project prompts into a single list.

import { useQuery } from "@tanstack/react-query";
import type { GlobalPrompt, ProjectPrompt } from "@zenbar/shared";
import { api } from "../api";
import { getGlobalPromptIdSet, mergeSavedPrompts } from "../lib/savedPrompts";

export function useSavedPrompts(projectId: string | null | undefined) {
  const projectPromptsQuery = useQuery({
    queryKey: ["project-prompts", projectId ?? null],
    queryFn: () => api.listProjectPrompts(projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  const globalPromptsQuery = useQuery({
    queryKey: ["global-prompts"],
    queryFn: api.listGlobalPrompts,
    staleTime: 60_000,
  });

  const savedPrompts = mergeSavedPrompts(
    globalPromptsQuery.data ?? [],
    projectPromptsQuery.data ?? []
  );

  const globalPromptIds = getGlobalPromptIdSet(globalPromptsQuery.data ?? []);

  return {
    savedPrompts,
    globalPromptIds,
    isLoading: projectPromptsQuery.isLoading || globalPromptsQuery.isLoading,
  };
}
