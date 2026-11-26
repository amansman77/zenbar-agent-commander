import { useLayoutEffect, useRef, useState } from "react";

const TOP_THRESHOLD = 96;
const BOTTOM_THRESHOLD = 48;

export function useTranscriptScroll(
  activeTab: "chat" | "diff",
  ready: boolean,
  oldestId: string | undefined,
  latestId: string | undefined,
  taskStatus: string | null | undefined,
  loadOlder: (beforePrepend: () => void) => void,
  olderLoadFailed: boolean,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatPosition = useRef(0);
  const previousTab = useRef(activeTab);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const [seenThrough, setSeenThrough] = useState<string | null>(null);
  const latestVisibleId = seenThrough ?? latestId;

  const scrollToLatest = () => {
    const panel = scrollRef.current;
    if (panel) {
      panel.scrollTop = panel.scrollHeight;
      chatPosition.current = panel.scrollTop;
    }
  };

  useLayoutEffect(() => {
    const panel = scrollRef.current;
    const returningToChat = previousTab.current === "diff";
    previousTab.current = activeTab;
    if (!panel || activeTab !== "chat" || !ready) return;

    const saved = anchor.current;
    anchor.current = null;
    if (saved && panel.contains(saved.element)) {
      // Measure a message instead of total height, since a response can also
      // arrive below the viewport while the older page is loading.
      panel.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
      chatPosition.current = panel.scrollTop;
    } else if (!seenThrough) {
      scrollToLatest();
    } else if (returningToChat) {
      panel.scrollTop = chatPosition.current;
    }
  }, [activeTab, ready, oldestId, latestVisibleId, seenThrough, taskStatus]);

  const requestOlder = () => loadOlder(() => {
    const panel = scrollRef.current;
    if (!panel) return;
    const viewport = panel.getBoundingClientRect();
    const visible = Array.from(panel.querySelectorAll<HTMLElement>("[data-message-id]")).find((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    if (visible) anchor.current = { element: visible, top: visible.getBoundingClientRect().top };
  });

  const handleScroll = () => {
    const panel = scrollRef.current;
    if (!panel || activeTab !== "chat") return;
    const movedUp = panel.scrollTop < chatPosition.current;
    chatPosition.current = panel.scrollTop;
    const nearBottom = panel.scrollHeight - panel.clientHeight - panel.scrollTop <= BOTTOM_THRESHOLD;
    setSeenThrough((previous) => nearBottom ? null : previous ?? latestVisibleId ?? null);
    if (movedUp && panel.scrollTop <= TOP_THRESHOLD && !olderLoadFailed) requestOlder();
  };

  return {
    scrollRef,
    handleScroll,
    requestOlder,
    seenThrough,
    hasNewMessages: seenThrough !== null && seenThrough !== latestId,
    showLatest: () => {
      setSeenThrough(null);
      scrollToLatest();
    },
  };
}
