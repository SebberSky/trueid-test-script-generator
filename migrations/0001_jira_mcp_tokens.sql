CREATE TABLE IF NOT EXISTS jira_mcp_tokens (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  access_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
