// Persists "where the user was" (screen + selected conversation/project/task)
// across a reload, because mobile browsers discard and reload backgrounded tabs.

export const LAST_VIEW_KEY = "zenbar:lastView";

export type DesktopView = "chat" | "workspace";

export type MobileScreen = "conversations" | "conversation-detail" | "projects" | "project-prompts" | "tasks" | "detail";

export type LastView = {
  mobileScreen: MobileScreen;
  desktopView?: DesktopView;
  selectedConversationId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
};

// Mobile browsers (iOS Safari especially) frequently discard a backgrounded
// tab and reload it fresh when the user switches back — plain in-memory
// React state (and history.pushState's state object) doesn't survive that,
// so without this the app always lands back on the root screen instead of
// wherever the user actually was.
export function loadLastView(): LastView | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastView;
    // A screen that depends on an id it doesn't have is unrenderable — fall
    // back to a safe default rather than restoring into a blank screen.
    if (parsed.mobileScreen === "conversation-detail" && !parsed.selectedConversationId) {
      return { ...parsed, mobileScreen: "conversations" };
    }
    if ((parsed.mobileScreen === "tasks" || parsed.mobileScreen === "project-prompts") && !parsed.selectedProjectId) {
      return { ...parsed, mobileScreen: "projects" };
    }
    if (parsed.mobileScreen === "detail" && !parsed.selectedTaskId) {
      return { ...parsed, mobileScreen: parsed.selectedProjectId ? "tasks" : "projects" };
    }
    return parsed;
  } catch {
    return null;
  }
}
