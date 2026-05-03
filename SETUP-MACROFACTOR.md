# MacroFactor sync — one-time setup

CalTrack now logs **real MacroFactor foods** (not just estimated macros) by talking
directly to MacroFactor's Firebase + Typesense backends. Three things have to
happen once:

1. Apply the database migration
2. Capture the iOS app's API keys with a TLS proxy
3. Set the Supabase secrets

## 1. Apply the migration

Open the Supabase SQL editor and run [supabase/migrations/20260503_add_macrofactor_sync_columns.sql](supabase/migrations/20260503_add_macrofactor_sync_columns.sql).
Adds five nullable columns to `food_logs`; non-breaking for old rows.

## 2. Capture the API keys

The MacroFactor app talks to three endpoints. Three values are baked into the
binary and must be sniffed once.

| Secret name              | Where it appears in app traffic                                              |
| ------------------------ | ----------------------------------------------------------------------------- |
| `MF_FIREBASE_API_KEY`    | Query string of `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=...` |
| `MF_TYPESENSE_HOST`      | Origin of the request to `/multi_search` (e.g. `https://xxxxxxxxx.typesense.net`)        |
| `MF_TYPESENSE_API_KEY`   | `x-typesense-api-key` header on the same `/multi_search` request                          |

Recommended tool: **Proxyman** on macOS (free tier is enough).

Steps:
1. Install Proxyman → enable HTTPS proxying for your iPhone (it walks you through CA install).
2. Force-quit MacroFactor and re-open it.
3. Log out and log back in — the sign-in request reveals `MF_FIREBASE_API_KEY`.
4. Search for any food in MacroFactor (the magnifying-glass tab). The first
   request to `*.typesense.net/multi_search` reveals the host and the
   `x-typesense-api-key` header.
5. Copy all three values.

Alternative: mitmproxy or Charles. Same captures.

> The Firebase API key + Typesense key are client-side keys (the iOS app ships
> them). They're not equivalent to your password, but treat them as
> semi-sensitive — anyone with them can search MacroFactor's food DB and run
> auth against accounts whose email/password they have.

## 3. Set Supabase secrets

In the Supabase dashboard → Project settings → Edge Functions → Secrets, add:

```
MF_FIREBASE_API_KEY=<from step 2>
MF_TYPESENSE_HOST=<from step 2, full https URL>
MF_TYPESENSE_API_KEY=<from step 2>

MF_EMAIL_NEVIL=<your MacroFactor login email>
MF_PASSWORD_NEVIL=<your MacroFactor password>

MF_EMAIL_MALOU=<Malou's email>
MF_PASSWORD_MALOU=<Malou's password>
```

The function reads `MF_EMAIL_<USER>` based on the `user` field in the request,
so case-uppercased names must match the secret suffix.

## 4. Deploy the Edge Functions

```bash
# from project root
supabase functions deploy parse-food
supabase functions deploy dashboard-api
```

Or, ask Claude to deploy via the Supabase MCP tool — both functions live under
`supabase/functions/` with a shared module at `supabase/functions/_shared/macrofactor.ts`.

## 5. Update the iOS Shortcut

The Shortcut still POSTs `{food, user}` to `parse-food` exactly as before, but
the response now includes `health_write` (boolean). Add a check before the
"Log to Apple Health" step:

- **Old**: always write totals to Apple Health.
- **New**: only write if `health_write == true`.

Why: when MacroFactor already received the entry as a real food (`health_write
= false`), writing the same totals to Apple Health would cause MacroFactor to
double-count via its Apple Health import.

Concretely, in the Shortcut:
1. After "Get Contents of URL", add "Get Dictionary Value" → key `health_write`.
2. Wrap the existing Apple Health log step in an `If <variable> is true`.

## How it routes

```
voice → Shortcut → parse-food
                     │
                     ├─ Claude extracts {items: [{query, grams, ...}], meal_time, ...}
                     │
                     ├─ for each item:
                     │     ├─ Typesense search → top result above threshold?
                     │     │     ├─ yes: log to Firestore, mf_status = matched
                     │     │     └─ no:  log estimated entry, mf_status = fallback
                     │     └─ on error:  mf_status = failed
                     │
                     └─ response.health_write = true unless ALL items matched
```

Failed/fallback rows surface as amber/red badges in the dashboard with a
one-click resync button.

## Rolling back

The migration only adds nullable columns; safe to leave even if you revert the
function. To revert the function, redeploy the previous git revision of
[supabase/functions/parse-food/index.ts](supabase/functions/parse-food/index.ts).
