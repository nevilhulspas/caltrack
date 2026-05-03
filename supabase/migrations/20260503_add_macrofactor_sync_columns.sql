-- Adds MacroFactor sync tracking to food_logs.
--   mf_status:    'matched'   = logged with a real MF food (Typesense match)
--                 'fallback'  = logged as estimated nutrition entry only
--                 'failed'    = MF write failed entirely (Apple Health may still have it)
--   mf_food_id:   Typesense food id used (null on fallback/failed)
--   mf_entry_id:  Firestore entry id MacroFactor assigned (null until logged)
--   mf_grams:     grams logged to MF — needed for resync without re-parsing
--   mf_logged_at: when MF write succeeded

alter table food_logs
  add column if not exists mf_status text,
  add column if not exists mf_food_id text,
  add column if not exists mf_entry_id text,
  add column if not exists mf_grams numeric,
  add column if not exists mf_logged_at timestamptz;

create index if not exists food_logs_mf_status_idx on food_logs(mf_status);
