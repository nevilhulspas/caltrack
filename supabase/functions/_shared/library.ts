// Library = the shared household's custom foods + composite recipes.
// Recipes are referred to as "meals" in the UI but stored as `recipes` to
// avoid colliding with the breakfast/lunch/snack/dinner "meal slot" concept.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CustomFood {
  id: string;
  name: string;
  brand: string | null;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  sugar_per_100g: number;
  sodium_per_100mg: number;
  sat_fat_per_100g: number;
  default_grams: number | null;
  notes: string | null;
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  position: number;
  fdc_id: string | null;
  custom_food_id: string | null;
  raw_name: string | null;
  grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  sugar_per_100g: number;
  sodium_per_100mg: number;
  sat_fat_per_100g: number;
}

export interface Recipe {
  id: string;
  name: string;
  notes: string | null;
  total_grams: number;
  total_kcal: number;
  total_protein: number;
  total_carbs: number;
  total_fat: number;
  total_fiber: number;
  total_sugar: number;
  total_sodium: number;
  total_sat_fat: number;
  ingredients?: RecipeIngredient[];
}

export interface LibraryMatch {
  kind: "custom_food" | "recipe";
  id: string;
  name: string;
  default_grams: number;
  // per-100g of consumed weight (recipes normalize totals / total_grams)
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  sugar_per_100g: number;
  sodium_per_100mg: number;
  sat_fat_per_100g: number;
}

const NUTRIENT_FIELDS = [
  "kcal_per_100g",
  "protein_per_100g",
  "carbs_per_100g",
  "fat_per_100g",
  "fiber_per_100g",
  "sugar_per_100g",
  "sodium_per_100mg",
  "sat_fat_per_100g",
] as const;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function loadCustomFoods(supabase: SupabaseClient): Promise<CustomFood[]> {
  const { data, error } = await supabase
    .from("custom_foods")
    .select("*")
    .eq("is_deleted", false)
    .order("name");
  if (error) throw new Error(`Loading custom foods failed: ${error.message}`);
  return (data ?? []) as CustomFood[];
}

export async function loadRecipes(
  supabase: SupabaseClient,
  withIngredients = false,
): Promise<Recipe[]> {
  const { data, error } = await supabase
    .from("recipes")
    .select("*")
    .eq("is_deleted", false)
    .order("name");
  if (error) throw new Error(`Loading recipes failed: ${error.message}`);
  const recipes = (data ?? []) as Recipe[];
  if (!withIngredients) return recipes;

  const { data: ings, error: ingErr } = await supabase
    .from("recipe_ingredients")
    .select("*")
    .in("recipe_id", recipes.map((r) => r.id))
    .order("position");
  if (ingErr) throw new Error(`Loading ingredients failed: ${ingErr.message}`);

  const byRecipe = new Map<string, RecipeIngredient[]>();
  for (const ing of (ings ?? []) as RecipeIngredient[]) {
    if (!byRecipe.has(ing.recipe_id)) byRecipe.set(ing.recipe_id, []);
    byRecipe.get(ing.recipe_id)!.push(ing);
  }
  return recipes.map((r) => ({ ...r, ingredients: byRecipe.get(r.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export async function loadMatchableLibrary(
  supabase: SupabaseClient,
): Promise<LibraryMatch[]> {
  const [foods, recipes] = await Promise.all([
    loadCustomFoods(supabase),
    loadRecipes(supabase, false),
  ]);

  const matches: LibraryMatch[] = [];
  for (const f of foods) {
    matches.push({
      kind: "custom_food",
      id: f.id,
      name: f.name,
      default_grams: Number(f.default_grams ?? 100),
      kcal_per_100g: Number(f.kcal_per_100g),
      protein_per_100g: Number(f.protein_per_100g),
      carbs_per_100g: Number(f.carbs_per_100g),
      fat_per_100g: Number(f.fat_per_100g),
      fiber_per_100g: Number(f.fiber_per_100g),
      sugar_per_100g: Number(f.sugar_per_100g),
      sodium_per_100mg: Number(f.sodium_per_100mg),
      sat_fat_per_100g: Number(f.sat_fat_per_100g),
    });
  }
  for (const r of recipes) {
    const totalGrams = Number(r.total_grams) || 1;
    const k = 100 / totalGrams; // scaling factor: totals → per-100g
    matches.push({
      kind: "recipe",
      id: r.id,
      name: r.name,
      default_grams: totalGrams,
      kcal_per_100g: Number(r.total_kcal) * k,
      protein_per_100g: Number(r.total_protein) * k,
      carbs_per_100g: Number(r.total_carbs) * k,
      fat_per_100g: Number(r.total_fat) * k,
      fiber_per_100g: Number(r.total_fiber) * k,
      sugar_per_100g: Number(r.total_sugar) * k,
      sodium_per_100mg: Number(r.total_sodium) * k,
      sat_fat_per_100g: Number(r.total_sat_fat) * k,
    });
  }
  return matches;
}

/**
 * Find the best library match for a query string. Cheap two-pass:
 *   1. Lowercase, strip punctuation, prefer entries whose name appears as a
 *      substring of the query (or vice versa) — longest match wins.
 *   2. If no substring overlap, drop to token-overlap (Jaccard on word set).
 *
 * Returns a single best match or null. Caller can additionally Haiku-rerank
 * if they want, but for personal-use libraries (10s of items) this works.
 */
export function findLibraryMatch(query: string, library: LibraryMatch[]): LibraryMatch | null {
  if (!library.length) return null;
  const q = normalize(query);
  if (!q) return null;

  // 1. Substring overlap
  let best: { item: LibraryMatch; score: number } | null = null;
  for (const item of library) {
    const n = normalize(item.name);
    if (!n) continue;
    if (q.includes(n) || n.includes(q)) {
      // Score = length of shorter side (so longer matches outrank shorter)
      const score = Math.min(q.length, n.length);
      if (!best || score > best.score) best = { item, score };
    }
  }
  if (best) return best.item;

  // 2. Token overlap fallback (Jaccard)
  const qTokens = new Set(q.split(/\s+/).filter((w) => w.length > 2));
  if (qTokens.size === 0) return null;
  let bestJ: { item: LibraryMatch; score: number } | null = null;
  for (const item of library) {
    const nTokens = new Set(normalize(item.name).split(/\s+/).filter((w) => w.length > 2));
    if (nTokens.size === 0) continue;
    const intersect = [...qTokens].filter((t) => nTokens.has(t)).length;
    if (intersect === 0) continue;
    const union = new Set([...qTokens, ...nTokens]).size;
    const j = intersect / union;
    if (j >= 0.5 && (!bestJ || j > bestJ.score)) bestJ = { item, score: j };
  }
  return bestJ?.item ?? null;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Macro helpers
// ---------------------------------------------------------------------------

export function libraryMacros(match: LibraryMatch, grams: number) {
  const k = grams / 100;
  return {
    calories: match.kcal_per_100g * k,
    protein_g: match.protein_per_100g * k,
    fat_g: match.fat_per_100g * k,
    carbs_g: match.carbs_per_100g * k,
    fiber_g: match.fiber_per_100g * k,
    sugar_g: match.sugar_per_100g * k,
    sodium_mg: match.sodium_per_100mg * k,
    saturated_fat_g: match.sat_fat_per_100g * k,
  };
}

// ---------------------------------------------------------------------------
// Recipe creation helper
// ---------------------------------------------------------------------------

export interface RecipeIngredientInput {
  fdc_id?: string | null;
  custom_food_id?: string | null;
  raw_name?: string | null;
  grams: number;
  // Per-100g nutrition (caller computes/snapshots before sending).
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  sugar_per_100g: number;
  sodium_per_100mg: number;
  sat_fat_per_100g: number;
}

export function computeRecipeTotals(ingredients: RecipeIngredientInput[]) {
  const totals = {
    total_grams: 0,
    total_kcal: 0,
    total_protein: 0,
    total_carbs: 0,
    total_fat: 0,
    total_fiber: 0,
    total_sugar: 0,
    total_sodium: 0,
    total_sat_fat: 0,
  };
  for (const i of ingredients) {
    const k = i.grams / 100;
    totals.total_grams += i.grams;
    totals.total_kcal += i.kcal_per_100g * k;
    totals.total_protein += i.protein_per_100g * k;
    totals.total_carbs += i.carbs_per_100g * k;
    totals.total_fat += i.fat_per_100g * k;
    totals.total_fiber += i.fiber_per_100g * k;
    totals.total_sugar += i.sugar_per_100g * k;
    totals.total_sodium += i.sodium_per_100mg * k;
    totals.total_sat_fat += i.sat_fat_per_100g * k;
  }
  return totals;
}

export { NUTRIENT_FIELDS };
