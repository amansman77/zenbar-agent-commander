import {
  COLLAPSED_CONVERSATION_GROUPS_KEY,
  loadCollapsedConversationGroups,
  saveCollapsedConversationGroups,
} from "./conversations";

describe("collapsed conversation groups persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a saved collapsed-groups map", () => {
    saveCollapsedConversationGroups({ "project-1": true, "project-2": false });
    expect(loadCollapsedConversationGroups()).toEqual({ "project-1": true, "project-2": false });
  });

  it("returns an empty map when nothing has been saved yet", () => {
    expect(loadCollapsedConversationGroups()).toEqual({});
  });

  it("falls back to an empty map for malformed stored JSON", () => {
    window.localStorage.setItem(COLLAPSED_CONVERSATION_GROUPS_KEY, "not json");
    expect(loadCollapsedConversationGroups()).toEqual({});
  });

  it("falls back to an empty map when the stored value isn't an object", () => {
    window.localStorage.setItem(COLLAPSED_CONVERSATION_GROUPS_KEY, "42");
    expect(loadCollapsedConversationGroups()).toEqual({});
  });
});
