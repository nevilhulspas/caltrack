import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getAuthFor,
  logEstimatedFood,
  logFood,
  searchFoods,
  toLogTime,
  type MfFood,
} from "../_shared/macrofactor.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Top Typesense match must clear this score to count as "real" — otherwise we
// fall back to the estimated nutrition path. The reference implementation's
// scores are typically in the millions for relevant hits and ~hundreds for
// noise; 100k is conservative.
const MATCH_SCORE_THRESHOLD = 100_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const EXTRACT_PROMPT = `You parse spoken/typed food descriptions into structured items. Return ONLY valid JSON, no other text.

Schema:
{
  "items": [
    {
      "query": "concise search term for a nutrition database (e.g. 'chicken breast cooked', 'jasmine rice cooked')",
      "grams": number,            // estimated weight in grams
      "estimated_calories": number,
      "estimated_protein_g": number,
      "estimated_carbs_g": number,
      "estimated_fat_g": number,
      "estimated_fiber_g": number,
      "estimated_sugar_g": number,
      "estimated_sodium_mg": number,
      "estimated_saturated_fat_g": number
    }
  ],
  "food_name": "brief summary of the whole meal",
  "notes": "context like 'post workout' or null",
  "date_offset_days": number or null,   // 0 today, -1 yesterday
  "meal_time": "breakfast" | "lunch" | "dinner" | "snack" | null
}

Rules:
- Split a meal into one item per food. "Chicken with rice" => two items.
- "query" must be a clean noun phrase searchable in USDA + branded food DBs.
- If grams are not stated, estimate a realistic single serving in grams.
- Estimated macros are a fallback in case database lookup fails — make them reasonable.`;

const UNDO_KEYWORDS = ["undo", "revert", "delete last", "remove last", "cancel last", "oops"];
const isUndoCommand = (t: string) => {
  const lower = t.toLowerCase().trim();
  return UNDO_KEYWORDS.some((k) => lower.includes(k));
};

interface ExtractedItem {
  query: string;
  grams: number;
  estimated_calories: number;
  estimated_protein_g: number;
  estimated_carbs_g: number;
  estimated_fat_g: number;
  estimated_fiber_g: number;
  estimated_sugar_g: number;
  estimated_sodium_mg: number;
  estimated_saturated_fat_g: number;
}

interface Extracted {
  items: ExtractedItem[];
  food_name: string;
  notes: string | null;
  date_offset_days: number | null;
  meal_time: "breakfast" | "lunch" | "dinner" | "snack" | null;
}

function calculateEntryDate(dateOffsetDays: number | null, mealTime: string | null): Date {
  const date = new Date();
  if (dateOffsetDays !== null && dateOffsetDays !== 0) {
    date.setDate(date.getDate() + dateOffsetDays);
  }
  switch (mealTime?.toLowerCase()) {
    case "breakfast": date.setHours(8, 0, 0, 0); break;
    case "lunch": date.setHours(12, 30, 0, 0); break;
    case "dinner": date.setHours(19, 0, 0, 0); break;
    case "snack": date.setHours(15, 0, 0, 0); break;
  }
  return date;
}

async function extractWithClaude(food: string): Promise<Extracted> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{ role: "user", content: `${EXTRACT_PROMPT}\n\nFood: ${food}` }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude error: ${await resp.text()}`);
  const data = await resp.json();
  let text = (data.content[0].text as string).trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(text) as Extracted;
}

function pickBestMatch(query: string, candidates: MfFood[]): MfFood | null {
  if (!candidates.length) return null;
  const top = candidates[0];
  if (top.searchScore < MATCH_SCORE_THRESHOLD) return null;
  return top;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { food, user } = await req.json();
    if (!food) return jsonResponse({ error: "Missing 'food' field" }, 400);

    const userName = user || "Unknown";

    // Undo path — soft-delete last entry, attempt to delete from MF too if we
    // tracked the entry id. (MF delete uses removeFields; we just blank locally
    // for now and surface this in the response so the dashboard can show it.)
    if (isUndoCommand(food)) {
      const { data: lastEntry, error: fetchError } = await supabase
        .from("food_logs")
        .select("id, food_name, mf_entry_id, entry_date")
        .eq("user_name", userName)
        .eq("is_deleted", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (fetchError || !lastEntry) {
        return jsonResponse({ message: "No recent meal found to undo", success: false });
      }
      const { error: deleteError } = await supabase
        .from("food_logs")
        .update({ is_deleted: true })
        .eq("id", lastEntry.id);
      if (deleteError) return jsonResponse({ error: "Failed to undo", details: deleteError.message }, 500);
      return jsonResponse({
        message: `Removed: ${lastEntry.food_name}`,
        undone: true,
        food_name: lastEntry.food_name,
        mf_entry_id: lastEntry.mf_entry_id,
      });
    }

    if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    // 1. Extract structured items + meal metadata from the user's input.
    const extracted = await extractWithClaude(food);
    const entryDate = calculateEntryDate(extracted.date_offset_days, extracted.meal_time);
    const logTime = toLogTime(entryDate);

    // 2. For each item: search MacroFactor → if confident match, log real food;
    //    otherwise log as estimated. Auth once; reuse across items.
    let auth;
    try {
      auth = await getAuthFor(userName);
    } catch (e) {
      console.error("MF auth failed:", (e as Error).message);
    }

    const itemResults: Array<{
      query: string;
      grams: number;
      mf_status: "matched" | "fallback" | "failed";
      mf_food_id: string | null;
      mf_entry_id: string | null;
      matched_name: string | null;
      calories: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      fiber_g: number;
      sugar_g: number;
      sodium_mg: number;
      saturated_fat_g: number;
    }> = [];

    for (const item of extracted.items) {
      let status: "matched" | "fallback" | "failed" = "fallback";
      let mfFoodId: string | null = null;
      let mfEntryId: string | null = null;
      let matchedName: string | null = null;
      let calories = item.estimated_calories;
      let protein = item.estimated_protein_g;
      let carbs = item.estimated_carbs_g;
      let fat = item.estimated_fat_g;

      if (auth) {
        try {
          const candidates = await searchFoods(item.query);
          const match = pickBestMatch(item.query, candidates);
          if (match) {
            // Use real per-100g macros scaled to the item's grams.
            calories = (match.caloriesPer100g * item.grams) / 100;
            protein = (match.proteinPer100g * item.grams) / 100;
            carbs = (match.carbsPer100g * item.grams) / 100;
            fat = (match.fatPer100g * item.grams) / 100;
            mfEntryId = await logFood(auth, match, item.grams, logTime);
            mfFoodId = match.foodId;
            matchedName = match.brand ? `${match.name} (${match.brand})` : match.name;
            status = "matched";
          } else {
            mfEntryId = await logEstimatedFood(
              auth,
              item.query,
              item.estimated_calories,
              item.estimated_protein_g,
              item.estimated_carbs_g,
              item.estimated_fat_g,
              logTime,
            );
            status = "fallback";
          }
        } catch (e) {
          console.error(`MF log failed for "${item.query}":`, (e as Error).message);
          status = "failed";
        }
      } else {
        status = "failed";
      }

      itemResults.push({
        query: item.query,
        grams: item.grams,
        mf_status: status,
        mf_food_id: mfFoodId,
        mf_entry_id: mfEntryId,
        matched_name: matchedName,
        calories,
        protein_g: protein,
        carbs_g: carbs,
        fat_g: fat,
        fiber_g: item.estimated_fiber_g,
        sugar_g: item.estimated_sugar_g,
        sodium_mg: item.estimated_sodium_mg,
        saturated_fat_g: item.estimated_saturated_fat_g,
      });
    }

    // 3. Persist each item as its own food_logs row so the dashboard can show
    //    per-item match status. raw_input is the original user phrase shared
    //    across rows; food_name uses the matched MF name when available.
    const rows = itemResults.map((r) => ({
      raw_input: food,
      food_name: r.matched_name ?? r.query,
      calories: r.calories,
      protein_g: r.protein_g,
      carbs_g: r.carbs_g,
      fat_g: r.fat_g,
      fiber_g: r.fiber_g,
      sugar_g: r.sugar_g,
      sodium_mg: r.sodium_mg,
      saturated_fat_g: r.saturated_fat_g,
      notes: extracted.notes,
      user_name: userName,
      is_deleted: false,
      entry_date: entryDate.toISOString(),
      mf_status: r.mf_status,
      mf_food_id: r.mf_food_id,
      mf_entry_id: r.mf_entry_id,
      mf_grams: r.grams,
      mf_logged_at: r.mf_status === "failed" ? null : new Date().toISOString(),
    }));

    const { error: dbError } = await supabase.from("food_logs").insert(rows);
    if (dbError) console.error("Database error:", dbError);

    // 4. Aggregate response. The iOS Shortcut uses these totals to write to
    //    Apple Health on the device — keep a single rolled-up object.
    const totals = itemResults.reduce(
      (acc, r) => ({
        calories: acc.calories + r.calories,
        protein_g: acc.protein_g + r.protein_g,
        carbs_g: acc.carbs_g + r.carbs_g,
        fat_g: acc.fat_g + r.fat_g,
        fiber_g: acc.fiber_g + r.fiber_g,
        sugar_g: acc.sugar_g + r.sugar_g,
        sodium_mg: acc.sodium_mg + r.sodium_mg,
        saturated_fat_g: acc.saturated_fat_g + r.saturated_fat_g,
      }),
      { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0, saturated_fat_g: 0 },
    );

    // The Shortcut should only write to Apple Health when MF didn't get the
    // matched entry — otherwise we double-count in MacroFactor (HealthKit
    // import + the Firestore entry). `health_write` tells it whether to.
    const anyMatched = itemResults.some((r) => r.mf_status === "matched");
    const allMatched = itemResults.every((r) => r.mf_status === "matched");

    return jsonResponse({
      ...totals,
      food_name: extracted.food_name,
      notes: extracted.notes,
      items: itemResults.map((r) => ({
        name: r.matched_name ?? r.query,
        grams: r.grams,
        mf_status: r.mf_status,
      })),
      mf_summary: {
        matched: itemResults.filter((r) => r.mf_status === "matched").length,
        fallback: itemResults.filter((r) => r.mf_status === "fallback").length,
        failed: itemResults.filter((r) => r.mf_status === "failed").length,
      },
      // Tells the iOS Shortcut whether to push macros to Apple Health.
      // false  = MF already has every item as a real food entry, skip HK.
      // true   = at least one item didn't reach MF, write totals to HK so
      //          MacroFactor still sees the macros via its HK import.
      health_write: !allMatched,
      health_write_partial: anyMatched && !allMatched,
    });
  } catch (error) {
    console.error("Error:", error);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
