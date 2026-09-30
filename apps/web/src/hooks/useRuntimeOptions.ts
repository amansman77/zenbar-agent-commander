// Shared queries for runtime engines, models, and profiles.
// Deduplicates query keys and stale times across TaskForm, ConversationDetailScreen, and useCommanderData.

import { useQuery } from "@tanstack/react-query";
import type {
  RuntimeEngineOption,
  RuntimeModelOption,
  RuntimeProfileOption,
} from "@zenbar/shared";
import { api } from "../api";

export function useRuntimeEngines() {
  const query = useQuery({
    queryKey: ["runtime-engines"],
    queryFn: () => api.listRuntimeEngines(),
    staleTime: 5 * 60 * 1000,
  });

  return {
    engines: (query.data?.engines ?? []) as RuntimeEngineOption[],
    defaultEngine: query.data?.default_engine ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useRuntimeModels(engine?: string | null) {
  const query = useQuery({
    queryKey: ["runtime-models", engine],
    queryFn: () => api.listRuntimeModels(engine),
    staleTime: 0,
  });

  return {
    models: (query.data?.models ?? []) as RuntimeModelOption[],
    source: query.data?.source ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}

export function useRuntimeProfiles(enabled: boolean = true) {
  const query = useQuery({
    queryKey: ["runtime-profiles"],
    queryFn: () => api.listRuntimeProfiles(),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  return {
    profiles: (enabled ? (query.data?.profiles ?? []) : []) as RuntimeProfileOption[],
    isLoading: query.isLoading,
    error: query.error,
  };
}
