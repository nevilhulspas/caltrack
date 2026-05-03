-- Adds USDA FoodData Central match tracking to food_logs.
--   usda_status:  'matched'   = real USDA food, scaled per-100g nutrition
--                 'estimated' = Claude estimate (no confident FDC match)
--   usda_fdc_id:  FDC food id (text) when matched
--   usda_grams:   grams logged — needed for resync without re-parsing

alter table food_logs
  add column if not exists usda_status text,
  add column if not exists usda_fdc_id text,
  add column if not exists usda_grams numeric;

create index if not exists food_logs_usda_status_idx on food_logs(usda_status);
