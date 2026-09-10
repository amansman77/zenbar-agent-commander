import { describe, expect, it } from "vitest";
import type { GlobalPrompt, ProjectPrompt } from "@zenbar/shared";
import { getGlobalPromptIdSet, mergeSavedPrompts } from "./savedPrompts";

describe("savedPrompts", () => {
  const globalPrompt1: GlobalPrompt = {
    id: "g1",
    title: "Global Prompt 1",
    content: "Global content 1",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    position: 1,
  };

  const projectPrompt1: ProjectPrompt = {
    id: "p1",
    project_id: "project-1",
    title: "Project Prompt 1",
    content: "Project content 1",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    position: 1,
  };

  it("merges global prompts before project prompts", () => {
    const merged = mergeSavedPrompts([globalPrompt1], [projectPrompt1]);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("g1");
    expect(merged[1].id).toBe("p1");
  });

  it("handles empty arrays gracefully", () => {
    expect(mergeSavedPrompts([], [])).toEqual([]);
    expect(mergeSavedPrompts([globalPrompt1], [])).toEqual([globalPrompt1]);
    expect(mergeSavedPrompts([], [projectPrompt1])).toEqual([projectPrompt1]);
  });

  it("extracts global prompt id set correctly", () => {
    const ids = getGlobalPromptIdSet([globalPrompt1]);
    expect(ids.has("g1")).toBe(true);
    expect(ids.has("p1")).toBe(false);
  });
});
