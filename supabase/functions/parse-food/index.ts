import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { displayName, scaleToGrams, searchFoods, type FdcFood } from "../_shared/usda.ts";
import {
  computeRecipeTotals,
  findLibraryMatch,
  libraryMacros,
  loadMatchableLibrary,
  type LibraryMatch,
  type RecipeIngredientInput,
} from "../_shared/library.ts";

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
- Estimated macros are a fallback in case database lookup fails — make them reasonable.

Extracting meal_time and date_offset_days:
- Listen for explicit meal cues anywhere in the input — "for lunch", "had breakfast", "at dinner", "as a snack", "voor de lunch", "bij het ontbijt", etc. — and set meal_time accordingly. The cue does not have to be at the start.
- If the input names a specific meal of the day, set meal_time even if no time is given.
- date_offset_days: 0 = today, -1 = yesterday, -2 = two days ago. Only set when the user explicitly references a past day ("yesterday", "gisteren", "two days ago"). Otherwise null.
- If no meal cue is mentioned, leave meal_time null.`;

const UNDO_KEYWORDS = ["undo", "revert", "delete last", "remove last", "cancel last", "oops"];
const isUndoCommand = (t: string) => {
  const lower = t.toLowerCase().trim();
  return UNDO_KEYWORDS.some((k) => lower.includes(k));
};

// Voice promote: "save this as Nevil's Protein Shake" / "save the last meal
// as <name>" / "save it as <name>". Captures the trailing name.
const SAVE_REGEXES = [
  /^\s*save\s+(?:this|that|it|the\s+last\s+(?:meal|entry|recipe))\s+as\s+(.+?)\s*[.!?]?\s*$/i,
  /^\s*save\s+as\s+(.+?)\s*[.!?]?\s*$/i,
  /^\s*sla\s+(?:dit|deze|de\s+laatste)\s+op\s+als\s+(.+?)\s*[.!?]?\s*$/i, // Dutch
];
function detectSaveCommand(text: string): string | null {
  for (const r of SAVE_REGEXES) {
    const m = text.match(r);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

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
  // If no meal_time was extracted, infer one from the current hour so the
  // dashboard still buckets it sensibly. The dashboard uses the same
  // boundaries (mealOf): <11 breakfast, <14 lunch, <17 snack, else dinner.
  let resolved = mealTime?.toLowerCase() || null;
  if (!resolved) {
    const h = date.getHours();
    if (h < 11) resolved = "breakfast";
    else if (h < 14) resolved = "lunch";
    else if (h < 17) resolved = "snack";
    else resolved = "dinner";
  }
  switch (resolved) {
    case "breakfast": date.setHours(8, 0, 0, 0); break;
    case "lunch": date.setHours(12, 30, 0, 0); break;
    case "dinner": date.setHours(19, 0, 0, 0); break;
    case "snack": date.setHours(15, 0, 0, 0); break;
  }
  return date;
}

// Build a minimal Extracted that captures the raw transcript as a single
// estimated item. Used as a graceful fallback whenever Claude is unreachable
// or returns malformed JSON — better to log _something_ the user can edit
// than to lose the meal entirely with a 500.
function fallbackExtracted(food: string): Extracted {
  return {
    items: [{
      query: food.slice(0, 80),
      grams: 100,
      estimated_calories: 0,
      estimated_protein_g: 0,
      estimated_carbs_g: 0,
      estimated_fat_g: 0,
      estimated_fiber_g: 0,
      estimated_sugar_g: 0,
      estimated_sodium_mg: 0,
      estimated_saturated_fat_g: 0,
    }],
    food_name: food.slice(0, 80),
    notes: "Parsing failed — please edit",
    date_offset_days: null,
    meal_time: null,
  };
}

async function extractWithClaude(food: string, libraryNames: string[] = []): Promise<Extracted> {
  // Tell Claude about the user's saved library so it doesn't split named
  // meals (e.g. "Nevils protein meal") into generic ingredients. If any of
  // these names appear in the input — even with minor variations from
  // speech-to-text — Claude must preserve them as a single item.
  const librarySection = libraryNames.length
    ? `\n\nThe user has saved these meal & custom-food names in their library:\n${libraryNames.map((n) => `- ${n}`).join("\n")}\n\nIf the input mentions any of them (allow loose matching for spelling, possessives, plurals, or speech-to-text noise — e.g. "Neville's" matches "Nevils", "protein shake" matches "Protein Shake"), output that saved name as ONE single item with query set to the EXACT saved name. Do not split a saved meal into its ingredients. Use grams the user explicitly stated, otherwise leave grams as 0.`
    : "";
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
      messages: [{ role: "user", content: `${EXTRACT_PROMPT}${librarySection}\n\nFood: ${food}` }],
    }),
  });
  if (!resp.ok) {
    console.error(`Claude HTTP error: ${resp.status} ${await resp.text()}`);
    return fallbackExtracted(food);
  }
  const data = await resp.json();
  const text0 = (data?.content?.[0]?.text as string | undefined) ?? "";
  let text = text0.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  try {
    const parsed = JSON.parse(text) as Extracted;
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      console.error("Claude returned no items:", text.slice(0, 500));
      return fallbackExtracted(food);
    }
    return parsed;
  } catch (e) {
    console.error("Claude JSON parse failed:", (e as Error).message, text.slice(0, 500));
    return fallbackExtracted(food);
  }
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

    // Voice "save this as <name>": find the most recent submission for this
    // user, group its rows, and create a recipe from them.
    const saveAsName = detectSaveCommand(food);
    if (saveAsName) {
      const { data: anchor } = await supabase
        .from("food_logs").select("*").eq("user_name", userName).eq("is_deleted", false)
        .order("created_at", { ascending: false }).limit(1).single();
      if (!anchor) return jsonResponse({ message: "No recent meal to save", success: false });
      const minute = anchor.created_at ? String(anchor.created_at).slice(0, 16) : "";
      const { data: siblings } = await supabase
        .from("food_logs").select("*").eq("user_name", userName)
        .eq("raw_input", anchor.raw_input).eq("is_deleted", false);
      const submission = (siblings ?? []).filter((r: any) => String(r.created_at).slice(0, 16) === minute);
      const rows = submission.length ? submission : [anchor];

      const ings: RecipeIngredientInput[] = rows.map((r: any) => {
        const grams = Number(r.usda_grams) || 100;
        const k = grams > 0 ? 100 / grams : 0;
        return {
          fdc_id: r.usda_fdc_id ?? null,
          custom_food_id: r.custom_food_id ?? null,
          raw_name: r.food_name ?? r.raw_input ?? null,
          grams,
          kcal_per_100g: (Number(r.calories) || 0) * k,
          protein_per_100g: (Number(r.protein_g) || 0) * k,
          carbs_per_100g: (Number(r.carbs_g) || 0) * k,
          fat_per_100g: (Number(r.fat_g) || 0) * k,
          fiber_per_100g: (Number(r.fiber_g) || 0) * k,
          sugar_per_100g: (Number(r.sugar_g) || 0) * k,
          sodium_per_100mg: (Number(r.sodium_mg) || 0) * k,
          sat_fat_per_100g: (Number(r.saturated_fat_g) || 0) * k,
        };
      });
      const totals = computeRecipeTotals(ings);
      const { data: recipe, error: rErr } = await supabase
        .from("recipes").insert({ name: saveAsName, ...totals }).select().single();
      if (rErr) return jsonResponse({ error: rErr.message }, 500);
      const ingRows = ings.map((i, idx) => ({ recipe_id: recipe.id, position: idx, ...i }));
      await supabase.from("recipe_ingredients").insert(ingRows);
      return jsonResponse({
        message: `Saved as meal: ${saveAsName}`,
        saved: true,
        recipe_id: recipe.id,
        food_name: saveAsName,
        items: rows.length,
      });
    }

    if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    // Load library once for matching all items in this submission.
    let library: LibraryMatch[] = [];
    try {
      library = await loadMatchableLibrary(supabase);
    } catch (e) {
      console.error("Library load failed:", (e as Error).message);
    }

    // 1. Claude splits the input into structured items + meal metadata.
    //    Pass library names so Claude preserves saved meals as single items
    //    instead of inventing generic ingredients for them.
    const extracted = await extractWithClaude(food, library.map((l) => l.name));
    const entryDate = calculateEntryDate(extracted.date_offset_days, extracted.meal_time);

    // 2. Per item: try the user's library first (custom foods + meals);
    //    fall back to USDA FDC; finally Claude's estimate. Library matches
    //    populate recipe_id or custom_food_id on the food_logs row.
    type ItemResult = {
      query: string;
      grams: number;
      status: "matched" | "estimated" | "library";
      fdc_id: number | null;
      recipe_id: string | null;
      custom_food_id: string | null;
      matched_name: string | null;
      calories: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      fiber_g: number;
      sugar_g: number;
      sodium_mg: number;
      saturated_fat_g: number;
    };

    const itemResults: ItemResult[] = await Promise.all(
      extracted.items.map(async (item): Promise<ItemResult> => {
        const fallback: ItemResult = {
          query: item.query, grams: item.grams,
          status: "estimated", fdc_id: null, recipe_id: null, custom_food_id: null,
          matched_name: null,
          calories: item.estimated_calories, protein_g: item.estimated_protein_g,
          carbs_g: item.estimated_carbs_g, fat_g: item.estimated_fat_g,
          fiber_g: item.estimated_fiber_g, sugar_g: item.estimated_sugar_g,
          sodium_mg: item.estimated_sodium_mg, saturated_fat_g: item.estimated_saturated_fat_g,
        };

        try {
          // Library first — substring/token match against custom foods + recipes.
          const lib = findLibraryMatch(item.query, library);
          if (lib) {
            // Snap to default_grams when user didn't say a quantity so totals
            // match the saved recipe rather than scaling fractionally.
            const grams = item.grams && item.grams > 0 ? item.grams : lib.default_grams;
            const macros = libraryMacros(lib, grams);
            return {
              query: item.query, grams, status: "library",
              fdc_id: null,
              recipe_id: lib.kind === "recipe" ? lib.id : null,
              custom_food_id: lib.kind === "custom_food" ? lib.id : null,
              matched_name: lib.name,
              ...macros,
            };
          }

          // USDA fallback
          const candidates = await searchFoods(item.query);
          const match = await pickBestMatchWithLlm(item, candidates);
          if (match) {
            const macros = scaleToGrams(match, item.grams);
            return {
              query: item.query, grams: item.grams, status: "matched",
              fdc_id: match.fdcId, recipe_id: null, custom_food_id: null,
              matched_name: displayName(match), ...macros,
            };
          }
          return fallback;
        } catch (e) {
          // Anything in this branch (library lookup, FDC search, Haiku rerank,
          // unexpected null/shape from a dependency) lands here. Returning the
          // fallback means a single bad item degrades to Claude's estimate
          // rather than 500-ing the whole submission.
          console.error(`Item "${item.query}" failed:`, (e as Error).message);
          return fallback;
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
      // Library matches mark usda_status="matched" so the existing dashboard
      // logic (no "estimated" badge) works; the recipe_id / custom_food_id
      // columns differentiate the source for the library badge.
      usda_status: r.status === "library" ? "matched" : r.status,
      usda_fdc_id: r.fdc_id ? String(r.fdc_id) : null,
      usda_grams: r.grams,
      recipe_id: r.recipe_id,
      custom_food_id: r.custom_food_id,
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
        library: itemResults.filter((r) => r.status === "library").length,
      },
    });
  } catch (error) {
    console.error("Error:", error);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
