CREATE TABLE IF NOT EXISTS public.retrohub_state (
  state_key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
