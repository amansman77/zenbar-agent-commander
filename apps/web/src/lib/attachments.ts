export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export function attachmentImageType(name: string): string | null {
  const extension = name.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  };
  return extension && typeof types[extension] === "string" ? types[extension] : null;
}

export function attachmentSelectionError(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENTS) return "메시지당 최대 10개 파일을 첨부할 수 있습니다.";
  if (files.some((file) => file.size === 0)) return "빈 파일은 첨부할 수 없습니다.";
  if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) return "파일당 최대 10MB까지 첨부할 수 있습니다.";
  return null;
}

export function attachmentSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.ceil(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
