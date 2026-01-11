import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SYSTEM_PROMPT = `You are a nutrition parser. Given a food description, return ONLY valid JSON with no other text.

Return this structure:
{
  "calories": number,
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "fiber_g": number,
  "sugar_g": number,
  "sodium_mg": number,
  "saturated_fat_g": number,
  "food_name": "brief summary of the food",
  "notes": "any additional context mentioned (e.g., 'felt hungry', 'cheat meal', 'post workout') or null if none",
  "date_offset_days": number or null,
  "meal_time": "breakfast" | "lunch" | "dinner" | "snack" | null
}

For date_offset_days: 0 = today, -1 = yesterday, -2 = two days ago, etc. Set to null if no date mentioned.
For meal_time: extract if mentioned (e.g., "at breakfast", "for dinner", "lunch"). Set to null if not mentioned.

Use your knowledge of nutrition databases. If weight is given, calculate accordingly. If weight is not given, assume a typical serving size. Only return valid JSON, no other text.`;

function calculateEntryDate(dateOffsetDays: number | null, mealTime: string | null): Date {
  const now = new Date();
  const date = new Date(now);

  // Apply date offset
  if (dateOffsetDays !== null && dateOffsetDays !== 0) {
    date.setDate(date.getDate() + dateOffsetDays);
  }

  // Apply meal time (approximate hours)
  if (mealTime) {
    switch (mealTime.toLowerCase()) {
      case 'breakfast':
        date.setHours(8, 0, 0, 0);
        break;
      case 'lunch':
        date.setHours(12, 30, 0, 0);
        break;
      case 'dinner':
        date.setHours(19, 0, 0, 0);
        break;
      case 'snack':
        date.setHours(15, 0, 0, 0);
        break;
    }
  }

  return date;
}

// Keywords that trigger undo/revert
const UNDO_KEYWORDS = ['undo', 'revert', 'delete last', 'remove last', 'cancel last', 'oops'];

function isUndoCommand(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return UNDO_KEYWORDS.some(keyword => lower.includes(keyword));
}

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { food, user } = await req.json();

    if (!food) {
      return new Response(
        JSON.stringify({ error: "Missing 'food' field" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if this is an undo command
    if (isUndoCommand(food)) {
      // Find and soft-delete the last entry for this user
      const { data: lastEntry, error: fetchError } = await supabase
        .from("food_logs")
        .select("id, food_name")
        .eq("user_name", user || "Unknown")
        .eq("is_deleted", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (fetchError || !lastEntry) {
        return new Response(
          JSON.stringify({
            message: "No recent meal found to undo",
            success: false
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Soft delete the entry
      const { error: deleteError } = await supabase
        .from("food_logs")
        .update({ is_deleted: true })
        .eq("id", lastEntry.id);

      if (deleteError) {
        console.error("Delete error:", deleteError);
        return new Response(
          JSON.stringify({ error: "Failed to undo", details: deleteError.message }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      return new Response(
        JSON.stringify({
          message: `Removed: ${lastEntry.food_name}`,
          undone: true,
          food_name: lastEntry.food_name
        }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // Regular food logging flow
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `${SYSTEM_PROMPT}\n\nFood: ${food}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Claude API error:", errorText);
      return new Response(
        JSON.stringify({ error: "Claude API error", details: errorText }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const claudeResponse = await response.json();
    const nutritionText = claudeResponse.content[0].text;

    // Parse the JSON from Claude's response (strip markdown code blocks if present)
    let nutrition;
    try {
      let jsonText = nutritionText.trim();
      // Remove markdown code blocks if present
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      }
      nutrition = JSON.parse(jsonText);
    } catch (e) {
      console.error("Failed to parse Claude response:", nutritionText);
      return new Response(
        JSON.stringify({ error: "Invalid JSON from Claude", raw: nutritionText }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Calculate entry date from Claude's response
    const entryDate = calculateEntryDate(nutrition.date_offset_days, nutrition.meal_time);

    // Store in Supabase
    const { error: dbError } = await supabase.from("food_logs").insert({
      raw_input: food,
      food_name: nutrition.food_name,
      calories: nutrition.calories,
      protein_g: nutrition.protein_g,
      carbs_g: nutrition.carbs_g,
      fat_g: nutrition.fat_g,
      fiber_g: nutrition.fiber_g,
      sugar_g: nutrition.sugar_g,
      sodium_mg: nutrition.sodium_mg,
      saturated_fat_g: nutrition.saturated_fat_g,
      notes: nutrition.notes,
      user_name: user || "Unknown",
      is_deleted: false,
      entry_date: entryDate.toISOString(),
    });

    if (dbError) {
      console.error("Database error:", dbError);
    }

    return new Response(JSON.stringify(nutrition), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
