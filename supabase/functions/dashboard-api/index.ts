import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { displayName, getFood, scaleToGrams, searchFoods } from "../_shared/usda.ts";

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
