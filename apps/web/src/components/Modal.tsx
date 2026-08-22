// Generic dialog shell used by the project/task/prompt modals.

import { type ReactNode } from "react";

export function Modal({
  title,
  open,
  onClose,
  fullScreenMobile = false,
  isMobile = false,
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  fullScreenMobile?: boolean;
  isMobile?: boolean;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }
  const mobileFullScreen = fullScreenMobile && isMobile;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal-card ${mobileFullScreen ? "modal-card-mobile-full" : ""}`}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="secondary modal-close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
