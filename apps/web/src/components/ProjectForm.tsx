// New-project form, including repo-path discovery via the folder browser.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  CreateProjectRequest,
  DiscoverProjectResponse
} from "@zenbar/shared";
import { api } from "../api";
import { FolderBrowser } from "./FolderBrowser";

export function ProjectForm({
  onCreate,
  onClose
}: {
  onCreate: (payload: CreateProjectRequest) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [lastDiscovered, setLastDiscovered] = useState<DiscoverProjectResponse | null>(null);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);

  const discoverProjectMutation = useMutation({
    mutationFn: api.discoverProject,
    onSuccess: (project) => {
      setLastDiscovered(project);
      setDiscoveryError(null);
      setName(project.name);
      setRepoPath(project.repo_path);
      setDefaultBranch(project.default_branch);
    },
    onError: (error: Error) => {
      setDiscoveryError(error.message);
    }
  });

  const canSubmit = Boolean(name.trim() && repoPath.trim() && defaultBranch.trim());

  return (
    <>
      {folderBrowserOpen && (
        <FolderBrowser
          onSelect={(path) => {
            setFolderBrowserOpen(false);
            discoverProjectMutation.mutate({ path });
          }}
          onClose={() => setFolderBrowserOpen(false)}
        />
      )}
      <form
        className="panel form-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ name, repo_path: repoPath, default_branch: defaultBranch });
        }}
      >
        <div className="panel-header">
          <h2>Web Commander</h2>
          <p>Create a project record for the Orchestration API.</p>
        </div>
        <button
          type="button"
          onClick={() => setFolderBrowserOpen(true)}
          disabled={discoverProjectMutation.isPending}
        >
          {discoverProjectMutation.isPending ? "Checking folder..." : "Browse folder"}
        </button>
        {discoveryError ? <p role="alert">{discoveryError}</p> : null}
        {lastDiscovered ? <p>Selected: {lastDiscovered.repo_path}</p> : null}
        <label>
          Project name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Repository path
          <input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
          />
        </label>
        <label>
          Default branch
          <input
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!canSubmit}>
          Create project
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </form>
    </>
  );
}
