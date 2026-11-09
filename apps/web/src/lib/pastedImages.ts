// Inline raster attachments travel with message content, including after a restart.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const PASTED_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function readPastedImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
    return Promise.reject(new Error("PNG, JPEG, GIF, WebP 이미지만 붙여넣을 수 있어요."));
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(new Error("이미지는 한 장당 5MB 이하여야 해요."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("이미지를 읽지 못했어요. 다시 붙여넣어 주세요."));
    reader.readAsDataURL(file);
  });
}

export function withPastedImages(text: string, images: string[]): string {
  return [text.trim(), ...images.map((url) => `![붙여넣은 이미지](${url})`)].filter(Boolean).join("\n\n");
}
