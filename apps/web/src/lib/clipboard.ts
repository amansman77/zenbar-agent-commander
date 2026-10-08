/**
 * Clipboard utilities for copying plain text to the system clipboard,
 * with fallback for browsers where navigator.clipboard is unavailable.
 */

export async function copyToClipboard(content: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch {
      // writeText can exist and still reject: a denied clipboard-write
      // permission, a permissions policy, or a document without focus.
      // The execCommand path below often still works then, so fall through
      // to it instead of reporting failure.
    }
  }
  try {
    if (typeof document !== "undefined") {
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.setAttribute("readonly", "true");
      // Fixed rather than absolute, so appending it never scrolls the page.
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      // iOS Safari does not select a textarea's text on select() alone, and
      // then copies nothing. This path is the one that runs there, because the phone
      // reaches the dashboard over plain HTTP, where navigator.clipboard
      // does not exist.
      textarea.setSelectionRange(0, content.length);
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      return success;
    }
    return false;
  } catch {
    return false;
  }
}
