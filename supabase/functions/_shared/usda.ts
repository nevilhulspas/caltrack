// USDA FoodData Central (FDC) client.
// Free public API — get a personal key at https://api.data.gov/signup/ and
// set it as the Supabase secret USDA_FDC_API_KEY. Falls back to DEMO_KEY
// (1000 req/hr global) if unset.
//
// Docs: https://fdc.nal.usda.gov/api-guide
//
// We query the combined dataset (Foundation + SR Legacy + Branded). Foundation
// and SR Legacy are USDA-curated; Branded is supplied by manufacturers and
// less reliable but covers packaged products MacroFactor's branded DB used to.

const FDC_BASE = "https://api.nal.usda.gov/fdc/v1";
const API_KEY = Deno.env.get("USDA_FDC_API_KEY") || "DEMO_KEY";

export interface FdcFood {
  fdcId: number;
  description: string;
  brand?: string;
  dataType: "Foundation" | "SR Legacy" | "Branded" | "Survey (FNDDS)" | string;
  caloriesPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  carbsPer100g: number;
  fiberPer100g: number;
  sugarPer100g: number;
  sodiumPer100mg: number; // sodium in mg per 100 g of food
  satFatPer100g: number;
  searchScore: number;
}

interface FdcNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  value?: number;
  unitName?: string;
}

interface FdcSearchHit {
  fdcId: number;
  description: string;
  brandOwner?: string;
  brandName?: string;
  dataType: string;
  score?: number;
  foodNutrients?: FdcNutrient[];
}

/**
 * Search USDA FDC for the top matches to a query.
 *
 * Two-pass strategy: try the curated USDA datasets (Foundation + SR Legacy)
 * first. Branded foods cram keywords into descriptions and dominate score
 * sorts, so we only fall through to Branded when curated returns nothing.
 *
 * Excludes Survey (FNDDS) which has odd cooked-state inconsistencies.
 */
export async function searchFoods(query: string, limit = 5): Promise<FdcFood[]> {
  const curated = await searchByType(query, ["Foundation", "SR Legacy"], limit);
  if (curated.length > 0 && curated[0].caloriesPer100g > 0) return curated;
  return await searchByType(query, ["Branded"], limit);
}

async function searchByType(query: string, dataType: string[], limit: number): Promise<FdcFood[]> {
  const url = `${FDC_BASE}/foods/search?api_key=${API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, pageSize: limit, dataType, sortBy: "score", sortOrder: "desc" }),
  });
  if (!resp.ok) throw new Error(`FDC search failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  return (data.foods ?? []).map(parseHit).filter((f: FdcFood | null): f is FdcFood => f !== null);
}

/**
 * Fetch a single food by fdcId — used by the resync path where we already
 * stored the id and just need fresh nutrition data.
 */
export async function getFood(fdcId: number): Promise<FdcFood | null> {
  const url = `${FDC_BASE}/food/${fdcId}?api_key=${API_KEY}`;
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`FDC get failed (${resp.status}): ${await resp.text()}`);
  return parseHit(await resp.json());
}

// FDC nutrient numbers we care about (USDA standard codes — same as MF used)
const N_PROTEIN = "203";
const N_FAT = "204";
const N_CARBS = "205";
const N_CALORIES = "208";
const N_FIBER = "291";
const N_SUGAR = "269";
const N_SODIUM = "307";
const N_SAT_FAT = "606";

function nutrientValue(nutrients: FdcNutrient[] | undefined, code: string): number {
  if (!nutrients) return 0;
  const hit = nutrients.find((n) => n.nutrientNumber === code || String(n.nutrientId) === code);
  return Number(hit?.value) || 0;
}

function parseHit(raw: FdcSearchHit | null): FdcFood | null {
  if (!raw || !raw.fdcId) return null;
  const brand = raw.brandName || raw.brandOwner;
  return {
    fdcId: raw.fdcId,
    description: raw.description,
    brand: brand && brand.trim() ? brand.trim() : undefined,
    dataType: raw.dataType,
    caloriesPer100g: nutrientValue(raw.foodNutrients, N_CALORIES),
    proteinPer100g: nutrientValue(raw.foodNutrients, N_PROTEIN),
    fatPer100g: nutrientValue(raw.foodNutrients, N_FAT),
    carbsPer100g: nutrientValue(raw.foodNutrients, N_CARBS),
    fiberPer100g: nutrientValue(raw.foodNutrients, N_FIBER),
    sugarPer100g: nutrientValue(raw.foodNutrients, N_SUGAR),
    sodiumPer100mg: nutrientValue(raw.foodNutrients, N_SODIUM),
    satFatPer100g: nutrientValue(raw.foodNutrients, N_SAT_FAT),
    searchScore: raw.score ?? 0,
  };
}

/** Scale per-100g nutrition to the requested grams. */
export function scaleToGrams(food: FdcFood, grams: number) {
  const k = grams / 100;
  return {
    calories: food.caloriesPer100g * k,
    protein_g: food.proteinPer100g * k,
    fat_g: food.fatPer100g * k,
    carbs_g: food.carbsPer100g * k,
    fiber_g: food.fiberPer100g * k,
    sugar_g: food.sugarPer100g * k,
    sodium_mg: food.sodiumPer100mg * k,
    saturated_fat_g: food.satFatPer100g * k,
  };
}

/** Combined display name including brand if present. */
export function displayName(food: FdcFood): string {
  return food.brand ? `${food.description} (${food.brand})` : food.description;
}
