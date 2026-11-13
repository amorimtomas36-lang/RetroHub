CREATE TABLE IF NOT EXISTS public.retrohub_state (
  state_key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Multi-AI conversations and debates. User ownership is enforced by the server API.
CREATE TABLE IF NOT EXISTS public.retrohub_ai_sessions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('chat', 'debate')),
  title TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS retrohub_ai_sessions_user_updated_idx
  ON public.retrohub_ai_sessions (user_id, updated_at DESC);
