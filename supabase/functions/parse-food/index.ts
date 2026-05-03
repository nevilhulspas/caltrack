import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { displayName, scaleToGrams, searchFoods, type FdcFood } from "../_shared/usda.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// FDC's score is an opaque relevance number — typical good matches are
// 200-1000, weak matches under 50. We require a minimum to avoid logging the
// wrong food, and fall back to Claude's estimate below the threshold.
const MATCH_SCORE_THRESHOLD = 100;

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
      "query": "concise USDA-style search term (e.g. 'chicken breast cooked', 'jasmine rice cooked', 'whole milk')",
      "grams": number,
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
  "date_offset_days": number or null,
  "meal_time": "breakfast" | "lunch" | "dinner" | "snack" | null
}

Rules:
- Split a meal into one item per food. "Chicken with rice" => two items.
- "query" must be a concise noun phrase that would match an entry in the USDA FoodData Central database.
- Include cooking state when relevant ("cooked", "raw", "grilled") — USDA has both.
- If grams aren't stated, estimate a realistic single serving in grams.
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

// Ask Claude to pick the best match for a given item from the top FDC
// candidates. FDC's text-relevance score rewards descriptions that pack in
// query keywords — so e.g. "chicken breast tenders, breaded, microwaved"
// outranks "chicken broilers or fryers, breast, meat only, cooked, roasted"
// for the query "chicken breast cooked." A short LLM rerank fixes this.
//
// Returns null if Claude judges no candidate is a good match.
async function pickBestMatchWithLlm(item: ExtractedItem, candidates: FdcFood[]): Promise<FdcFood | null> {
  const usable = candidates.filter((c) => c.caloriesPer100g > 0 && c.searchScore >= MATCH_SCORE_THRESHOLD);
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0];

  const list = usable
    .map((c, i) => `${i}: ${c.description}${c.brand ? ` [${c.brand}]` : ""} — ${Math.round(c.caloriesPer100g)} kcal/100g`)
    .join("\n");

  const prompt = `Pick the best match for the user's food from these USDA FoodData Central candidates.

User said: "${item.query}" (${item.grams}g)

Candidates:
${list}

Rules:
- Prefer plain, unprocessed forms unless the user said otherwise (e.g. "chicken breast" should pick plain cooked breast meat, not breaded tenders).
- Match cooking state when stated.
- If the user mentioned a specific brand, prefer that brand.
- If no candidate is a reasonable match, reply "none".

Reply with ONLY the candidate index number (e.g. "2"), or "none". No other text.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude rerank error: ${await resp.text()}`);
  const data = await resp.json();
  const text = (data.content[0].text as string).trim().toLowerCase();
  if (text.startsWith("none")) return null;
  const idx = parseInt(text, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= usable.length) return null;
  return usable[idx];
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

    if (isUndoCommand(food)) {
      const { data: lastEntry, error: fetchError } = await supabase
        .from("food_logs")
        .select("id, food_name")
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
      });
    }

    if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    // 1. Claude splits the input into structured items + meal metadata.
    const extracted = await extractWithClaude(food);
    const entryDate = calculateEntryDate(extracted.date_offset_days, extracted.meal_time);

    // 2. Per item: search USDA FDC. Confident match → real nutrition. Otherwise
    //    fall back to Claude's estimate so we never hard-fail the log.
    const itemResults = await Promise.all(
      extracted.items.map(async (item) => {
        try {
          const candidates = await searchFoods(item.query);
          const match = await pickBestMatchWithLlm(item, candidates);
          if (match) {
            const macros = scaleToGrams(match, item.grams);
            return {
              query: item.query,
              grams: item.grams,
              status: "matched" as const,
              fdc_id: match.fdcId,
              matched_name: displayName(match),
              ...macros,
            };
          }
          return {
            query: item.query,
            grams: item.grams,
            status: "estimated" as const,
            fdc_id: null as number | null,
            matched_name: null as string | null,
            calories: item.estimated_calories,
            protein_g: item.estimated_protein_g,
            carbs_g: item.estimated_carbs_g,
            fat_g: item.estimated_fat_g,
            fiber_g: item.estimated_fiber_g,
            sugar_g: item.estimated_sugar_g,
            sodium_mg: item.estimated_sodium_mg,
            saturated_fat_g: item.estimated_saturated_fat_g,
          };
        } catch (e) {
          console.error(`FDC search failed for "${item.query}":`, (e as Error).message);
          return {
            query: item.query,
            grams: item.grams,
            status: "estimated" as const,
            fdc_id: null as number | null,
            matched_name: null as string | null,
            calories: item.estimated_calories,
            protein_g: item.estimated_protein_g,
            carbs_g: item.estimated_carbs_g,
            fat_g: item.estimated_fat_g,
            fiber_g: item.estimated_fiber_g,
            sugar_g: item.estimated_sugar_g,
            sodium_mg: item.estimated_sodium_mg,
            saturated_fat_g: item.estimated_saturated_fat_g,
          };
        }
      }),
    );

    // 3. One row per item so the dashboard can show per-item match status.
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
      usda_status: r.status,
      usda_fdc_id: r.fdc_id ? String(r.fdc_id) : null,
      usda_grams: r.grams,
    }));

    const { error: dbError } = await supabase.from("food_logs").insert(rows);
    if (dbError) console.error("Database error:", dbError);

    // 4. Aggregate totals for the iOS Shortcut to write to Apple Health.
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

    return jsonResponse({
      ...totals,
      food_name: extracted.food_name,
      notes: extracted.notes,
      items: itemResults.map((r) => ({
        name: r.matched_name ?? r.query,
        grams: r.grams,
        usda_status: r.status,
      })),
      usda_summary: {
        matched: itemResults.filter((r) => r.status === "matched").length,
        estimated: itemResults.filter((r) => r.status === "estimated").length,
      },
    });
  } catch (error) {
    console.error("Error:", error);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
