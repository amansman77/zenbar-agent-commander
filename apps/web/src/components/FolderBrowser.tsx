// Server-side directory browser used to pick a repo path.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  FsBrowseResponse
} from "@zenbar/shared";
import { api } from "../api";
import { useIsMobileBreakpoint } from "../hooks/useIsMobileBreakpoint";

export function FolderBrowser({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobileBreakpoint();
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);

  const { data, isLoading, error } = useQuery<FsBrowseResponse>({
    queryKey: ["fs-browse", currentPath],
    queryFn: () => api.browseFs(currentPath),
  });

  const cardClass = isMobile ? "modal-card modal-card-mobile-full" : "modal-card";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={cardClass} style={isMobile ? {} : { maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={isMobile ? { padding: "8px 16px" } : { marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "1rem" }}>폴더 선택</h2>
          <button className="modal-close-button secondary" onClick={onClose}>✕</button>
        </div>

        <div style={isMobile ? { padding: "12px 16px" } : {}}>
          {data && (
            <div style={{ marginBottom: "0.5rem", fontSize: "0.82rem", color: "var(--text-soft)", wordBreak: "break-all" }}>
              {data.path}
            </div>
          )}

          {isLoading && <p style={{ color: "var(--text-soft)", fontSize: "0.88rem" }}>로딩 중...</p>}
          {error && <p style={{ color: "#b12a34", fontSize: "0.88rem" }}>오류: {(error as Error).message}</p>}

          {data && (
            <div style={{ display: "grid", gap: "0.4rem", maxHeight: isMobile ? "calc(100vh - 240px)" : "340px", overflowY: "auto" }}>
              {data.parent !== null && (
                <button
                  className="list-item"
                  style={{ textAlign: "left" }}
                  onClick={() => setCurrentPath(data.parent!)}
                >
                  ↑ 상위 폴더
                </button>
              )}
              {data.entries.length === 0 && (
                <p className="empty-state">하위 폴더가 없습니다.</p>
              )}
              {data.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="list-item"
                  style={{ textAlign: "left" }}
                  onClick={() => setCurrentPath(entry.path)}
                >
                  📁 {entry.name}
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
            <button
              disabled={!data}
              onClick={() => data && onSelect(data.path)}
            >
              이 폴더 선택
            </button>
            <button className="secondary" onClick={onClose}>취소</button>
          </div>
        </div>
      </div>
    </div>
  );
}
