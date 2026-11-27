import { useState } from "react";
import type { ConversationMessageItem } from "@zenbar/shared";
import { api } from "../api";
import { attachmentImageType, attachmentSize } from "../lib/attachments";
import { AttachmentImageViewer } from "./AttachmentImageViewer";

export function MessageAttachments({ message }: { message: ConversationMessageItem }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = message.attachments?.find((attachment) => attachment.id === selectedId);
  if (!message.attachments?.length) return null;
  return (
    <>
      <ul className="message-attachments" aria-label="첨부파일">
        {message.attachments.map((attachment) => (
          <li key={attachment.id}>
            {attachmentImageType(attachment.name) ? (
              <button type="button" className="attachment-image-link" onClick={() => setSelectedId(attachment.id)}>
                {attachment.name} <span>({attachmentSize(attachment.size)})</span>
              </button>
            ) : (
              <a
                href={api.conversationAttachmentUrl(message.conversation_id, attachment.id)}
                download={attachment.name}
                referrerPolicy="no-referrer"
              >
                {attachment.name} <span>({attachmentSize(attachment.size)})</span>
              </a>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <AttachmentImageViewer
          key={selected.id}
          conversationId={message.conversation_id}
          attachment={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}
