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

const PASTED_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

// Every browser hands a pasted screenshot over as a File named "image.png",
// so two pastes would upload, list and reach the agent under the same name.
// A timestamped name keeps them apart. Only raster types the transcript can
// preview are taken; anything else on the clipboard is left to the textarea.
export function pastedImageFiles(files: File[], now: Date): File[] {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return files
    .filter((file) => PASTED_IMAGE_EXTENSIONS[file.type])
    .map((file, index) => new File(
      [file],
      `붙여넣은 이미지 ${stamp}${index > 0 ? `-${index + 1}` : ""}.${PASTED_IMAGE_EXTENSIONS[file.type]}`,
      { type: file.type },
    ));
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
