import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetail, ConversationMessageItem } from "@zenbar/shared";
import { api } from "../api";
import { ACTIVE_TASK_STATUSES } from "../lib/notifications";

const INITIAL_LIMIT = 5;
const PAGE_LIMIT = 30;

export function useConversationHistory(conversationId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["conversation", conversationId];
  const [older, setOlder] = useState<{ messages: ConversationMessageItem[]; hasMore: boolean }>();
  const requestedBefore = useRef<string | null>(null);

  const { data: conversation, isLoading } = useQuery({
    queryKey,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<ConversationDetail>(queryKey);
      if (!previous) {
        return api.getConversation(conversationId, { limit: INITIAL_LIMIT }, signal);
      }

      // An empty cursor represents an already-open conversation that was
      // empty. Its first poll must start at the beginning even after a burst.
      const page = await api.getConversation(conversationId, {
        after: previous.messages[previous.messages.length - 1]?.id ?? "",
        limit: PAGE_LIMIT,
      }, signal);
      return {
        ...page,
        messages: page.messages.length ? [...previous.messages, ...page.messages] : previous.messages,
        has_more_messages: previous.has_more_messages,
      };
    },
    refetchInterval: (query) => {
      const status = query.state.data?.task_status;
      return status && ACTIVE_TASK_STATUSES.includes(status) ? 1500 : 3000;
    },
  });

  const olderMutation = useMutation({
    mutationFn: ({ before }: { before: string; beforePrepend: () => void }) =>
      api.getConversation(conversationId, { before, limit: PAGE_LIMIT }),
    onSuccess: (page, { beforePrepend }) => {
      if (page.messages.length) beforePrepend();
      setOlder((previous) => ({
        messages: [...page.messages, ...(previous?.messages ?? [])],
        hasMore: page.has_more_messages,
      }));
    },
    onError: () => {
      requestedBefore.current = null;
    },
  });

  const firstId = older?.messages[0]?.id ?? conversation?.messages[0]?.id;
  const hasOlder = older?.hasMore ?? conversation?.has_more_messages ?? false;
  const messages = useMemo(() => [
    ...(older?.messages ?? []), ...(conversation?.messages ?? []),
  ], [older?.messages, conversation?.messages]);

  return {
    conversation,
    isLoading,
    messages,
    hasOlder,
    isLoadingOlder: olderMutation.isPending,
    olderLoadFailed: olderMutation.isError,
    loadOlder: (beforePrepend: () => void) => {
      if (firstId && hasOlder && requestedBefore.current !== firstId) {
        requestedBefore.current = firstId;
        olderMutation.mutate({ before: firstId, beforePrepend });
      }
    },
  };
}
