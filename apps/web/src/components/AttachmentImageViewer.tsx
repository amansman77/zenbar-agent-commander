import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationAttachmentItem } from "@zenbar/shared";
import { api } from "../api";
import { attachmentImageType } from "../lib/attachments";

export function AttachmentImageViewer({ conversationId, attachment, onClose }: {
  conversationId: string;
  attachment: ConversationAttachmentItem;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    api.getConversationAttachment(conversationId, attachment.id, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type: attachmentImageType(attachment.name) ?? "image/png" }));
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, attachment.id, attachment.name]);

  return createPortal(
    <dialog ref={dialog} className="attachment-image-viewer" aria-label={`${attachment.name} 이미지 미리보기`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="attachment-image-viewer-content">
        <div className="attachment-image-viewer-header">
          <h2>{attachment.name}</h2>
          <a href={api.conversationAttachmentUrl(conversationId, attachment.id)} download={attachment.name}
            referrerPolicy="no-referrer">다운로드</a>
          <button type="button" className="secondary modal-close-button" aria-label="이미지 미리보기 닫기" onClick={onClose}>×</button>
        </div>
        {failed ? <p role="alert">이미지를 표시할 수 없습니다. 다운로드하여 확인해주세요.</p>
          : imageUrl ? <div className="attachment-image-viewer-body"><img src={imageUrl} alt={attachment.name} onError={() => setFailed(true)} /></div>
          : <p role="status">이미지를 불러오는 중입니다…</p>}
      </div>
    </dialog>, document.body,
  );
}
