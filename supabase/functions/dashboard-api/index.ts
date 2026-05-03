import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { displayName, scaleToGrams, searchFoods } from "../_shared/usda.ts";

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

  // Resync — POST ?action=resync&id=X
  // Re-runs USDA FDC search for an existing food_logs row that came in as
  // `estimated`. Updates nutrition columns with real data on a confident match.
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
