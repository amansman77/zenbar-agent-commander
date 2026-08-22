// Project picker list with delete affordance.

import type {
  ProjectSummary
} from "@zenbar/shared";

// Shared by the mobile Projects screen and the desktop sidebar, which
// previously carried byte-for-byte copies of this markup that only differed
// in where a row click navigates to. They had already drifted apart (the
// Prompts button was 0.78rem on one side and 0.8rem on the other).
export function ProjectList({
  projects,
  selectedProjectId,
  onSelect,
  onOpenPrompts,
  emptyText,
}: {
  projects: ProjectSummary[] | undefined;
  selectedProjectId: string | null;
  onSelect: (project: ProjectSummary) => void;
  onOpenPrompts: (project: ProjectSummary) => void;
  emptyText: string;
}) {
  if (!projects?.length) {
    return <p className="empty-state">{emptyText}</p>;
  }
  return (
    <>
      {projects.map((project) => (
        <div
          key={project.id}
          className={project.id === selectedProjectId ? "list-item active" : "list-item"}
          style={{ display: "flex", alignItems: "center", gap: "8px" }}
          title={project.repo_path}
        >
          <button
            type="button"
            onClick={() => onSelect(project)}
            style={{
              flex: 1,
              minWidth: 0,
              textAlign: "left",
              background: "none",
              border: "none",
              padding: 0,
              color: "inherit",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            <strong>{project.name}</strong>
            <span className="item-secondary truncate">{project.repo_path}</span>
          </button>
          <button
            type="button"
            className="secondary"
            style={{ flexShrink: 0, fontSize: "0.8rem", padding: "4px 10px" }}
            onClick={() => onOpenPrompts(project)}
          >
            Prompts
          </button>
        </div>
      ))}
    </>
  );
}
