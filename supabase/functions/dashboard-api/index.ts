import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthFor, logFood, searchFoods, toLogTime } from "../_shared/macrofactor.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MATCH_SCORE_THRESHOLD = 100_000;

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
  // Re-runs MacroFactor search+log for an existing food_logs row that came in
  // as `fallback` or `failed`. Uses food_name as the query and the stored
  // mf_grams (or falls back to a 100g default) as the quantity.
  if (req.method === "POST" && action === "resync") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing 'id' parameter" }, 400);

    const { data: row, error } = await supabase
      .from("food_logs")
      .select("id, user_name, food_name, raw_input, entry_date, mf_grams")
      .eq("id", id)
      .single();
    if (error || !row) return json({ error: "Entry not found" }, 404);

    try {
      const auth = await getAuthFor(row.user_name || "Unknown");
      const candidates = await searchFoods(row.food_name || row.raw_input);
      if (!candidates.length || candidates[0].searchScore < MATCH_SCORE_THRESHOLD) {
        return json({ status: "fallback", message: "No confident MacroFactor match" });
      }
      const grams = Number(row.mf_grams) || 100;
      const match = candidates[0];
      const logTime = toLogTime(new Date(row.entry_date));
      const entryId = await logFood(auth, match, grams, logTime);
      const matchedName = match.brand ? `${match.name} (${match.brand})` : match.name;

      await supabase
        .from("food_logs")
        .update({
          mf_status: "matched",
          mf_food_id: match.foodId,
          mf_entry_id: entryId,
          mf_grams: grams,
          mf_logged_at: new Date().toISOString(),
          food_name: matchedName,
          calories: (match.caloriesPer100g * grams) / 100,
          protein_g: (match.proteinPer100g * grams) / 100,
          carbs_g: (match.carbsPer100g * grams) / 100,
          fat_g: (match.fatPer100g * grams) / 100,
        })
        .eq("id", id);

      return json({ status: "matched", food_name: matchedName, mf_entry_id: entryId });
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
