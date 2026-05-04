import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { displayName, getFood, scaleToGrams, searchFoods } from "../_shared/usda.ts";
import {
  computeRecipeTotals,
  loadCustomFoods,
  loadRecipes,
  type RecipeIngredientInput,
} from "../_shared/library.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MATCH_SCORE_THRESHOLD = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // GET ?action=search&q=... — return USDA candidates for a relink picker.
  // ─────────────────────────── Library ───────────────────────────

  if (req.method === "GET" && action === "library") {
    try {
      const [custom_foods, recipes] = await Promise.all([
        loadCustomFoods(supabase),
        loadRecipes(supabase, true),
      ]);
      return json({ custom_foods, recipes });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (req.method === "POST" && action === "create-custom-food") {
    const body = await req.json().catch(() => ({}));
    if (!body.name) return json({ error: "name required" }, 400);
    const row = pickCustomFoodFields(body);
    const { data, error } = await supabase.from("custom_foods").insert(row).select().single();
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "POST" && action === "update-custom-food") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const body = await req.json().catch(() => ({}));
    const row = pickCustomFoodFields(body);
    row.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from("custom_foods").update(row).eq("id", id).select().single();
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "DELETE" && action === "delete-custom-food") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const { error } = await supabase.from("custom_foods").update({ is_deleted: true }).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  if (req.method === "POST" && (action === "create-recipe" || action === "update-recipe")) {
    const isUpdate = action === "update-recipe";
    const id = isUpdate ? url.searchParams.get("id") : null;
    if (isUpdate && !id) return json({ error: "Missing 'id' parameter" }, 400);
    const body = await req.json().catch(() => ({}));
    if (!body.name) return json({ error: "name required" }, 400);
    if (!Array.isArray(body.ingredients) || body.ingredients.length === 0) {
      return json({ error: "ingredients required" }, 400);
    }

    // Normalize incoming ingredients — backend trusts client per-100g values
    // to skip extra USDA fetches; the dashboard form populates them after
    // search picks a USDA hit or a custom food.
    const ings: RecipeIngredientInput[] = body.ingredients.map((i: any, idx: number) => ({
      fdc_id: i.fdc_id ? String(i.fdc_id) : null,
      custom_food_id: i.custom_food_id ?? null,
      raw_name: i.raw_name ?? null,
      grams: Number(i.grams) || 0,
      kcal_per_100g: Number(i.kcal_per_100g) || 0,
      protein_per_100g: Number(i.protein_per_100g) || 0,
      carbs_per_100g: Number(i.carbs_per_100g) || 0,
      fat_per_100g: Number(i.fat_per_100g) || 0,
      fiber_per_100g: Number(i.fiber_per_100g) || 0,
      sugar_per_100g: Number(i.sugar_per_100g) || 0,
      sodium_per_100mg: Number(i.sodium_per_100mg) || 0,
      sat_fat_per_100g: Number(i.sat_fat_per_100g) || 0,
      _position: idx,
    } as RecipeIngredientInput & { _position: number }));

    const totals = computeRecipeTotals(ings);
    const recipeRow = {
      name: String(body.name).trim(),
      notes: body.notes ?? null,
      ...totals,
      updated_at: new Date().toISOString(),
    };

    let recipeId = id as string;
    if (isUpdate) {
      const { error } = await supabase.from("recipes").update(recipeRow).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      // wipe old ingredients
      await supabase.from("recipe_ingredients").delete().eq("recipe_id", id);
    } else {
      const { data, error } = await supabase.from("recipes").insert(recipeRow).select().single();
      if (error) return json({ error: error.message }, 500);
      recipeId = data.id;
    }

    const ingRows = ings.map((i, idx) => ({
      recipe_id: recipeId,
      position: idx,
      fdc_id: i.fdc_id ?? null,
      custom_food_id: i.custom_food_id ?? null,
      raw_name: i.raw_name ?? null,
      grams: i.grams,
      kcal_per_100g: i.kcal_per_100g,
      protein_per_100g: i.protein_per_100g,
      carbs_per_100g: i.carbs_per_100g,
      fat_per_100g: i.fat_per_100g,
      fiber_per_100g: i.fiber_per_100g,
      sugar_per_100g: i.sugar_per_100g,
      sodium_per_100mg: i.sodium_per_100mg,
      sat_fat_per_100g: i.sat_fat_per_100g,
    }));
    if (ingRows.length) {
      const { error } = await supabase.from("recipe_ingredients").insert(ingRows);
      if (error) return json({ error: error.message }, 500);
    }
    const { data: full } = await supabase.from("recipes").select("*").eq("id", recipeId).single();
    return json(full);
  }

  if (req.method === "DELETE" && action === "delete-recipe") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const { error } = await supabase.from("recipes").update({ is_deleted: true }).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  // POST ?action=log-items — direct typed-in log, no Claude/parsing.
  // Accepts a list of items (USDA, custom food, recipe, or free-form) with
  // grams and per-100g macros. Writes one food_logs row per item, all
  // sharing the same raw_input + created_at minute so they group as one
  // submission on the dashboard.
  if (req.method === "POST" && action === "log-items") {
    const body = await req.json().catch(() => ({}));
    const userName = String(body.user || "").trim() || "Unknown";
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json({ error: "items required" }, 400);

    // Resolve meal slot to canonical UTC entry_date.
    const slot: Record<string, [number, number]> = {
      breakfast: [8, 0], lunch: [12, 30], snack: [15, 0], dinner: [19, 0],
    };
    const date = new Date();
    const offset = Number(body.date_offset_days);
    if (Number.isFinite(offset) && offset !== 0) date.setDate(date.getDate() + offset);
    const meal = String(body.meal || "").toLowerCase();
    if (slot[meal]) {
      const [h, m] = slot[meal];
      date.setUTCHours(h, m, 0, 0);
    } else {
      // Auto-bucket from current UTC hour.
      const h = date.getUTCHours();
      const auto = h < 11 ? "breakfast" : h < 14 ? "lunch" : h < 17 ? "snack" : "dinner";
      const [hh, mm] = slot[auto];
      date.setUTCHours(hh, mm, 0, 0);
    }
    const entryDate = date.toISOString();
    const rawInput = String(body.raw_input || items.map((i: any) => `${Math.round(Number(i.grams) || 0)}g ${i.name || i.raw_name || "food"}`).join(", "));

    const rows = items.map((i: any) => {
      const grams = Number(i.grams) || 0;
      const k = grams / 100;
      const kcal = (Number(i.kcal_per_100g) || 0) * k;
      const protein = (Number(i.protein_per_100g) || 0) * k;
      const carbs = (Number(i.carbs_per_100g) || 0) * k;
      const fat = (Number(i.fat_per_100g) || 0) * k;
      const fiber = (Number(i.fiber_per_100g) || 0) * k;
      const sugar = (Number(i.sugar_per_100g) || 0) * k;
      const sodium = (Number(i.sodium_per_100mg) || 0) * k;
      const satFat = (Number(i.sat_fat_per_100g) || 0) * k;
      const fdcId = i.fdc_id ? String(i.fdc_id) : null;
      return {
        raw_input: rawInput,
        food_name: i.name || i.raw_name || "Food",
        calories: kcal, protein_g: protein, carbs_g: carbs, fat_g: fat,
        fiber_g: fiber, sugar_g: sugar, sodium_mg: sodium, saturated_fat_g: satFat,
        notes: i.notes || null,
        user_name: userName,
        is_deleted: false,
        entry_date: entryDate,
        // If a USDA fdc_id was supplied, mark matched. If a recipe or custom
        // food id is set, also matched (the badge reads the recipe/food id).
        // Otherwise treat as estimated (free-form entry).
        usda_status: fdcId || i.recipe_id || i.custom_food_id ? "matched" : "estimated",
        usda_fdc_id: fdcId,
        usda_grams: grams,
        recipe_id: i.recipe_id || null,
        custom_food_id: i.custom_food_id || null,
      };
    });

    const { error: dbErr } = await supabase.from("food_logs").insert(rows);
    if (dbErr) return json({ error: dbErr.message }, 500);
    return json({ logged: rows.length, entry_date: entryDate });
  }

  // Convert one logged submission (a food_log row + its siblings sharing
  // raw_input + minute) into a saved recipe. Subsequent voice logs that
  // mention this name will match the recipe.
  if (req.method === "POST" && action === "promote-submission") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "name required" }, 400);

    const { data: anchor, error: anchorErr } = await supabase
      .from("food_logs").select("*").eq("id", id).single();
    if (anchorErr || !anchor) return json({ error: "Entry not found" }, 404);

    const minuteBucket = anchor.created_at ? String(anchor.created_at).slice(0, 16) : "";
    const { data: siblings } = await supabase
      .from("food_logs")
      .select("*")
      .eq("user_name", anchor.user_name)
      .eq("raw_input", anchor.raw_input)
      .eq("is_deleted", false);

    const submission = (siblings ?? []).filter((r: any) => {
      const rb = r.created_at ? String(r.created_at).slice(0, 16) : "";
      return rb === minuteBucket;
    });
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
    const { data: recipe, error } = await supabase
      .from("recipes")
      .insert({ name, ...totals })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    const ingRows = ings.map((i, idx) => ({ recipe_id: recipe.id, position: idx, ...i }));
    await supabase.from("recipe_ingredients").insert(ingRows);
    return json(recipe);
  }

  if (req.method === "GET" && action === "search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q || q.length < 2) return json({ results: [] });
    try {
      const candidates = await searchFoods(q, 8);
      const results = candidates.map((c) => ({
        fdc_id: c.fdcId,
        name: c.description,
        brand: c.brand ?? null,
        data_type: c.dataType,
        kcal_per_100g: Math.round(c.caloriesPer100g),
        protein_per_100g: Math.round(c.proteinPer100g),
        carbs_per_100g: Math.round(c.carbsPer100g),
        fat_per_100g: Math.round(c.fatPer100g),
        score: Math.round(c.searchScore),
      }));
      return json({ results });
    } catch (e) {
      return json({ error: (e as Error).message, results: [] }, 500);
    }
  }

  // POST ?action=resync&id=X — re-run USDA search for an estimated entry.
  if (req.method === "POST" && action === "resync") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);

    const { data: row, error } = await supabase
      .from("food_logs")
      .select("id, food_name, raw_input, usda_grams")
      .eq("id", id)
      .single();
    if (error || !row) return json({ error: "Entry not found" }, 404);

    try {
      const candidates = await searchFoods(row.food_name || row.raw_input);
      const top = candidates[0];
      if (!top || top.searchScore < MATCH_SCORE_THRESHOLD || top.caloriesPer100g === 0) {
        return json({ status: "estimated", message: "No confident USDA match" });
      }
      const grams = Number(row.usda_grams) || 100;
      const macros = scaleToGrams(top, grams);

      await supabase
        .from("food_logs")
        .update({
          usda_status: "matched",
          usda_fdc_id: String(top.fdcId),
          usda_grams: grams,
          food_name: displayName(top),
          ...macros,
        })
        .eq("id", id);

      return json({ status: "matched", food_name: displayName(top), fdc_id: top.fdcId });
    } catch (e) {
      console.error("Resync failed:", (e as Error).message);
      return json({ status: "failed", error: (e as Error).message }, 500);
    }
  }

  // POST ?action=update-meal&id=X  body {meal}
  // Moves an entry to a different meal slot by rewriting entry_date to the
  // canonical UTC hour for that meal. Keeps the same calendar date.
  if (req.method === "POST" && action === "update-meal") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const body = await req.json().catch(() => ({}));
    const meal = String(body.meal || "").toLowerCase();
    const slot: Record<string, [number, number]> = {
      breakfast: [8, 0],
      lunch: [12, 30],
      snack: [15, 0],
      dinner: [19, 0],
    };
    if (!slot[meal]) return json({ error: "meal must be breakfast|lunch|snack|dinner" }, 400);

    const { data: row, error } = await supabase
      .from("food_logs").select("id, entry_date").eq("id", id).single();
    if (error || !row) return json({ error: "Entry not found" }, 404);

    // Preserve the calendar date (UTC) and rewrite the time-of-day.
    const d = new Date(row.entry_date);
    const [h, m] = slot[meal];
    d.setUTCHours(h, m, 0, 0);

    const { error: upErr } = await supabase
      .from("food_logs").update({ entry_date: d.toISOString() }).eq("id", id);
    if (upErr) return json({ error: upErr.message }, 500);
    return json({ status: "ok", meal, entry_date: d.toISOString() });
  }

  // POST ?action=update-grams&id=X  body {grams}
  // Updates only the gram weight. If the row has a stored usda_fdc_id, also
  // recomputes calories/macros from that food's per-100g data. For estimated
  // entries (no fdc_id), we just store the new grams without rescaling — the
  // original Claude estimate stays put.
  if (req.method === "POST" && action === "update-grams") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const body = await req.json().catch(() => ({}));
    const grams = Number(body.grams);
    if (!Number.isFinite(grams) || grams <= 0) {
      return json({ error: "grams must be a positive number" }, 400);
    }

    const { data: row, error } = await supabase
      .from("food_logs")
      .select("id, usda_fdc_id, usda_status")
      .eq("id", id)
      .single();
    if (error || !row) return json({ error: "Entry not found" }, 404);

    const update: Record<string, unknown> = { usda_grams: grams };

    if (row.usda_fdc_id) {
      try {
        const food = await getFood(Number(row.usda_fdc_id));
        if (food) {
          const macros = scaleToGrams(food, grams);
          Object.assign(update, macros);
        }
      } catch (e) {
        console.error("getFood failed during update-grams:", (e as Error).message);
      }
    }

    const { error: upErr } = await supabase.from("food_logs").update(update).eq("id", id);
    if (upErr) return json({ error: upErr.message }, 500);
    return json({ status: "ok", grams, recomputed: !!row.usda_fdc_id });
  }

  // POST ?action=relink&id=X  body {fdc_id, grams?}
  // Replaces the USDA food behind an entry. Looks up the new food, scales to
  // either the provided grams or the existing usda_grams, and rewrites
  // nutrition + name + status to "matched".
  if (req.method === "POST" && action === "relink") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const body = await req.json().catch(() => ({}));
    const fdcId = Number(body.fdc_id);
    if (!Number.isFinite(fdcId) || fdcId <= 0) {
      return json({ error: "fdc_id must be a positive number" }, 400);
    }

    const { data: row, error } = await supabase
      .from("food_logs")
      .select("id, usda_grams")
      .eq("id", id)
      .single();
    if (error || !row) return json({ error: "Entry not found" }, 404);

    const grams = Number.isFinite(Number(body.grams)) && Number(body.grams) > 0
      ? Number(body.grams)
      : (Number(row.usda_grams) || 100);

    try {
      const food = await getFood(fdcId);
      if (!food) return json({ error: "Food not found in FDC" }, 404);
      const macros = scaleToGrams(food, grams);

      const { error: upErr } = await supabase
        .from("food_logs")
        .update({
          usda_status: "matched",
          usda_fdc_id: String(food.fdcId),
          usda_grams: grams,
          food_name: displayName(food),
          ...macros,
        })
        .eq("id", id);
      if (upErr) return json({ error: upErr.message }, 500);

      return json({
        status: "matched",
        food_name: displayName(food),
        fdc_id: food.fdcId,
        grams,
        ...macros,
      });
    } catch (e) {
      console.error("Relink failed:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);
    const { error } = await supabase.from("food_logs").update({ is_deleted: true }).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  // GET — list logs
  const user = url.searchParams.get("user");
  const days = parseInt(url.searchParams.get("days") || "7");
  let query = supabase
    .from("food_logs")
    .select("*")
    .eq("is_deleted", false)
    .gte("entry_date", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
    .order("entry_date", { ascending: false });
  if (user) query = query.eq("user_name", user);
  const { data: logs, error } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ logs: logs || [] });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickCustomFoodFields(b: any): Record<string, unknown> {
  return {
    name: String(b.name || "").trim(),
    brand: b.brand ? String(b.brand).trim() : null,
    kcal_per_100g: Number(b.kcal_per_100g) || 0,
    protein_per_100g: Number(b.protein_per_100g) || 0,
    carbs_per_100g: Number(b.carbs_per_100g) || 0,
    fat_per_100g: Number(b.fat_per_100g) || 0,
    fiber_per_100g: Number(b.fiber_per_100g) || 0,
    sugar_per_100g: Number(b.sugar_per_100g) || 0,
    sodium_per_100mg: Number(b.sodium_per_100mg) || 0,
    sat_fat_per_100g: Number(b.sat_fat_per_100g) || 0,
    default_grams: b.default_grams ? Number(b.default_grams) : null,
    notes: b.notes ?? null,
  };
}
