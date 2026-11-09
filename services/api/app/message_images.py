"""Inline raster attachments stored in message markdown.

Summaries omit image data so polling the conversation list does not repeatedly
transfer megabytes of base64 or use it as a task/worktree name.
"""

import re

INLINE_IMAGE_RE = re.compile(
    r"!\[[^\]]*\]\((data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2})\)"
)


def message_preview(content: str) -> str:
    return INLINE_IMAGE_RE.sub("[첨부 이미지]", content)
