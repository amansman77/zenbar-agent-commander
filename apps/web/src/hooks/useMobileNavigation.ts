import { useEffect, useRef, useState } from "react";
import { LAST_VIEW_KEY, type DesktopView, type MobileScreen } from "../lib/viewState";

interface UseMobileNavigationOptions {
  isMobile: boolean;
  initialScreen: MobileScreen;
  desktopView: DesktopView;
  selectedConversationId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
}

const BACK_MAP: Partial<Record<MobileScreen, MobileScreen>> = {
  "conversation-detail": "conversations",
  "projects": "conversations",
  "project-prompts": "projects",
  "tasks": "projects",
  "detail": "tasks",
};

export function useMobileNavigation({
  isMobile,
  initialScreen,
  desktopView,
  selectedConversationId,
  selectedProjectId,
  selectedTaskId,
}: UseMobileNavigationOptions) {
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>(initialScreen);
  const isHandlingPopState = useRef(false);

  useEffect(() => {
    if (!isMobile) {
      setMobileScreen("conversations");
    }
  }, [isMobile]);

  // Remember the current screen so a reloaded tab (e.g. iOS Safari
  // discarding a backgrounded tab) can reopen where the user left off
  // instead of always landing back on the root screen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        LAST_VIEW_KEY,
        JSON.stringify({ mobileScreen, desktopView, selectedConversationId, selectedProjectId, selectedTaskId })
      );
    } catch {
      // Quota exceeded or private-mode storage — losing "resume where you left off" isn't worth surfacing an error for.
    }
  }, [mobileScreen, desktopView, selectedConversationId, selectedProjectId, selectedTaskId]);

  // Push a history entry each time the mobile screen changes
  useEffect(() => {
    if (!isMobile) return;
    if (isHandlingPopState.current) {
      isHandlingPopState.current = false;
      return;
    }
    window.history.pushState({ mobileScreen }, "");
  }, [mobileScreen, isMobile]);

  // Handle browser back button on mobile
  useEffect(() => {
    if (!isMobile) return;
    const handlePopState = (e: PopStateEvent) => {
      const prevScreen = (e.state as { mobileScreen?: MobileScreen } | null)?.mobileScreen;
      const target = prevScreen ?? BACK_MAP[mobileScreen] ?? "conversations";
      isHandlingPopState.current = true;
      setMobileScreen(target);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile, mobileScreen]);

  return {
    mobileScreen,
    setMobileScreen,
  };
}
