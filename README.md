# CalTrack - Voice Food Logger

Voice-activated food logging for MacroFactor via iOS Shortcuts, Supabase, and Apple Health.

## How It Works

```
Speak food → iOS transcribes → Supabase Edge Function → Claude → Apple Health → MacroFactor
                                        ↓
                                 Store in database
                                        ↓
                                    Dashboard
```

## Features

- **Voice input** - Just speak what you ate, no typing or searching
- **Multi-user support** - Multiple people can use the same backend
- **Food history** - All entries stored in Supabase for tracking
- **Web dashboard** - View and filter food logs from any device
- **Undo/revert** - Say "undo" or "delete last" to remove the last entry
- **Notes** - Add context like "post workout" or "cheat meal"
- **Multi-language** - Works in Dutch, English, and other languages
- **Detailed macros** - Tracks calories, protein, carbs, fat, fiber, sugar, sodium, saturated fat

## Architecture

| Component | Purpose |
|-----------|---------|
| iOS Shortcuts | Voice input, Apple Health logging |
| Supabase Edge Functions | API endpoint, Claude integration |
| Supabase Database | Food history storage |
| GitHub Pages | Dashboard hosting |
| Claude API | Nutrition parsing |
| Apple Health | Macro storage, MacroFactor sync |

## Quick Start

### 1. Set Up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Run the database migration:

```sql
create table food_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  raw_input text not null,
  food_name text,
  calories numeric,
  protein_g numeric,
  carbs_g numeric,
  fat_g numeric,
  fiber_g numeric,
  sugar_g numeric,
  sodium_mg numeric,
  saturated_fat_g numeric,
  notes text,
  user_name text,
  is_deleted boolean default false
);

create index food_logs_created_at_idx on food_logs(created_at desc);
create index food_logs_user_name_idx on food_logs(user_name);
```

3. Deploy the Edge Functions (see `supabase/functions/`)
4. Set `ANTHROPIC_API_KEY` in your Supabase project secrets

### 2. Install the Shortcut

1. Open this link on your iPhone: [CalTrack Shortcut](https://www.icloud.com/shortcuts/3a9f061a3d74420d94069f6a8386c73c)
2. Tap **Add Shortcut**
3. Edit the shortcut and update:
   - The URL to your Supabase project
   - The username to your name

### 3. Enable MacroFactor Sync

1. Open MacroFactor
2. Go to **More > Integrations > Apple Health**
3. Enable **Import nutrition data from Apple Health**

### 4. Test It

1. Run the Shortcut
2. Say: "200 grams of chicken breast and a cup of rice"
3. Check Apple Health > Browse > Nutrition
4. Open MacroFactor - the food should appear
5. Check the dashboard to see it logged

## Usage

**Log food:**
"Two eggs with toast and a glass of milk"

**Log with notes:**
"Protein shake, post workout"

**Log in Dutch:**
"Twee boterhammen met kaas"

**Undo last entry:**
"Undo" or "Delete last" or "Oops"

## Dashboard

View your food history at: `https://YOUR_USERNAME.github.io/caltrack/dashboard.html`

Features:
- Filter by user
- Filter by time range (Today, 7 days, 30 days)
- Daily totals per user
- Mobile-friendly

## Cost

- Claude API: ~$0.003 per log
- Supabase: Free tier (generous limits)
- GitHub Pages: Free
- **Total**: ~$1/month for 10 logs/day

## Troubleshooting

### Food not appearing in MacroFactor

1. Check Apple Health > Nutrition to verify data was logged
2. Ensure MacroFactor has permission to read from Apple Health
3. Pull down to refresh in MacroFactor

### API errors

1. Verify your Anthropic API key is set in Supabase secrets
2. Check Edge Function logs in Supabase dashboard
3. Ensure you have internet connection

### Inaccurate nutrition data

Claude uses its training data for nutrition estimates. For more accuracy:
- Include weights: "200g chicken" vs "some chicken"
- Be specific: "grilled chicken breast" vs "chicken"
- Mention preparation: "fried" vs "baked"

## Privacy

- Voice transcription happens on-device via iOS
- Food descriptions are sent to Supabase and Claude API
- Nutrition data is stored in Supabase (your own project)
- Data also stored in Apple Health on your device

## Files

| File | Purpose |
|------|---------|
| `README.md` | This file |
| `dashboard.html` | Web dashboard for viewing food history |
| `supabase/functions/` | Edge Function source code |

## API Endpoints

### POST `/functions/v1/parse-food`

Parse food and log to database.

```json
{
  "food": "200g chicken with rice",
  "user": "Nevil"
}
```

**Undo last entry:**
```json
{
  "food": "undo",
  "user": "Nevil"
}
```

### GET `/functions/v1/dashboard-api`

Get food logs as JSON.

```
?user=Nevil&days=7
```

## License

MIT
