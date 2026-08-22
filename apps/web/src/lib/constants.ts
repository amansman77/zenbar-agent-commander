// Values shared across more than one screen: the actor name the API attributes
// web actions to, localStorage keys, and small runtime capability lists.

export const actor = "web-commander";

export const LAST_TASK_MODEL_KEY = "zenbar:lastTaskModel";

// Engines whose adapter implements get_usage() for real -- see
// ClaudeCliAdapter/AntigravityCliAdapter/AppServerWebSocketAdapter.
// GrokCliAdapter always returns null (confirmed no equivalent CLI/RPC
// exists), so it's deliberately excluded here rather than just letting the
// query fire and return null every time.
export const USAGE_SUPPORTED_ENGINES = ["codex", "antigravity", "claude"];

export const CONVERSATION_GROUP_PREVIEW_COUNT = 3;
