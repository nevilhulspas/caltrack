// Unofficial MacroFactor client for Deno (Supabase Edge Functions).
// Reverse-engineered from the public sjawhar/macrofactor reference
// implementation (MIT licensed). Talks directly to:
//   1. Firebase Identity Toolkit  (sign-in + token refresh)
//   2. MacroFactor Typesense host (food search)
//   3. Firestore REST             (write food entries)
//
// Required env vars:
//   MF_FIREBASE_API_KEY   — Firebase web API key for the sbs-diet-app project
//   MF_TYPESENSE_HOST     — e.g. https://xxx.typesense.net
//   MF_TYPESENSE_API_KEY  — read-only search key shipped with the iOS app
//   MF_EMAIL_<USER>       — per-user MacroFactor email (e.g. MF_EMAIL_NEVIL)
//   MF_PASSWORD_<USER>    — per-user password
//
// All three keys/hosts are baked into the MacroFactor mobile app. Capture them
// once by routing the app through a TLS-decrypting proxy (Proxyman / Charles /
// mitmproxy) and inspecting the first auth + search requests.

const FIREBASE_API_KEY = Deno.env.get("MF_FIREBASE_API_KEY") ?? "";
const TYPESENSE_HOST = Deno.env.get("MF_TYPESENSE_HOST") ?? "";
const TYPESENSE_API_KEY = Deno.env.get("MF_TYPESENSE_API_KEY") ?? "";
const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/sbs-diet-app/databases/(default)/documents";
const BUNDLE_ID_HEADER = { "X-Ios-Bundle-Identifier": "com.sbs.diet" };

export interface MfAuth {
  idToken: string;
  refreshToken: string;
  uid: string;
  expiresAt: number; // epoch ms
}

export interface MfFoodServing {
  description: string;
  amount: number;
  gramWeight: number;
}

export interface MfFood {
  foodId: string;
  name: string;
  brand?: string;
  caloriesPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  carbsPer100g: number;
  servings: MfFoodServing[];
  imageId?: string;
  nutrientsPer100g: Record<string, number>;
  branded: boolean;
  searchScore: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signIn(email: string, password: string): Promise<MfAuth> {
  if (!FIREBASE_API_KEY) throw new Error("MF_FIREBASE_API_KEY not configured");
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...BUNDLE_ID_HEADER },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!resp.ok) {
    throw new Error(`MF sign-in failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
  };
}

// In-memory token cache keyed by email. Edge Functions are short-lived but
// concurrent invocations within the same instance reuse this.
const TOKEN_CACHE = new Map<string, MfAuth>();

export async function getAuthFor(user: string): Promise<MfAuth> {
  const upper = user.toUpperCase();
  const email = Deno.env.get(`MF_EMAIL_${upper}`);
  const password = Deno.env.get(`MF_PASSWORD_${upper}`);
  if (!email || !password) {
    throw new Error(`MF credentials missing for user "${user}"`);
  }
  const cached = TOKEN_CACHE.get(email);
  // Refresh 60s before actual expiry
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const auth = await signIn(email, password);
  TOKEN_CACHE.set(email, auth);
  return auth;
}

// ---------------------------------------------------------------------------
// Typesense food search
// ---------------------------------------------------------------------------

export async function searchFoods(query: string): Promise<MfFood[]> {
  if (!TYPESENSE_HOST || !TYPESENSE_API_KEY) {
    throw new Error("Typesense host/key not configured");
  }
  const resp = await fetch(`${TYPESENSE_HOST}/multi_search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-typesense-api-key": TYPESENSE_API_KEY,
    },
    body: JSON.stringify({
      searches: [
        { collection: "common_foods", q: query, query_by: "foodDesc", per_page: 5 },
        { collection: "branded_foods", q: query, query_by: "foodDesc,brandName", per_page: 5 },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Typesense search failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  const out: MfFood[] = [];
  for (let i = 0; i < (data.results?.length ?? 0); i++) {
    const branded = i === 1;
    for (const hit of data.results[i]?.hits ?? []) {
      const parsed = parseHit(hit.document, branded);
      if (!parsed) continue;
      parsed.searchScore = hit.text_match_info?.best_field_score ?? hit.text_match ?? 0;
      out.push(parsed);
    }
  }
  out.sort((a, b) => b.searchScore - a.searchScore);
  return out;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  return 0;
}

function parseHit(doc: Record<string, unknown> | undefined, branded: boolean): MfFood | null {
  if (!doc) return null;
  const nutrients: Record<string, number> = {};
  const nObj = doc.nutrients;
  if (nObj && typeof nObj === "object" && !Array.isArray(nObj)) {
    for (const [k, v] of Object.entries(nObj as Record<string, unknown>)) {
      nutrients[k] = num(v);
    }
  }
  for (const [k, v] of Object.entries(doc)) {
    if (/^n\d+$/.test(k)) nutrients[k.substring(1)] = num(v);
    else if (/^\d{3}$/.test(k)) nutrients[k] = num(v);
  }
  const servings: MfFoodServing[] = [];
  if (Array.isArray(doc.weights)) {
    for (const w of doc.weights as Record<string, unknown>[]) {
      if (w && typeof w === "object") {
        servings.push({
          description: String(w.msreDesc ?? w.description ?? w.label ?? "serving"),
          amount: num(w.amount ?? 1),
          gramWeight: num(w.gmWgt ?? w.gramWeight ?? w.weight ?? 100),
        });
      }
    }
  }
  if (servings.length === 0 && doc.dfSrv && typeof doc.dfSrv === "object") {
    const ds = doc.dfSrv as Record<string, unknown>;
    servings.push({
      description: String(ds.msreDesc ?? ds.description ?? "serving"),
      amount: num(ds.amount ?? 1),
      gramWeight: num(ds.gmWgt ?? ds.gramWeight ?? 100),
    });
  }
  if (!servings.some((s) => s.gramWeight === 100)) {
    servings.push({ description: "100 g", amount: 1, gramWeight: 100 });
  }
  return {
    foodId: String(doc.id ?? doc.fdcId ?? ""),
    name: String(doc.foodDesc ?? doc.description ?? ""),
    brand: branded ? (doc.brandName as string | undefined) : undefined,
    caloriesPer100g: nutrients["208"] ?? num(doc.calories) ?? num(doc.energy) ?? 0,
    proteinPer100g: nutrients["203"] ?? num(doc.protein) ?? 0,
    fatPer100g: nutrients["204"] ?? num(doc.fat) ?? num(doc.totalFat) ?? 0,
    carbsPer100g: nutrients["205"] ?? num(doc.carbs) ?? num(doc.carbohydrate) ?? 0,
    servings,
    imageId: (doc.imageId ?? doc.x) as string | undefined,
    nutrientsPer100g: nutrients,
    branded,
    searchScore: 0,
  };
}

// ---------------------------------------------------------------------------
// Firestore food-entry write
// ---------------------------------------------------------------------------
// MacroFactor's Android app crashes if numeric fields are written as
// integerValue/doubleValue. Everything must be stringValue (with `.0` on
// integers). Booleans use booleanValue; nulls use nullValue.

type FieldValue =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { arrayValue: { values: Array<{ mapValue: { fields: Record<string, FieldValue> } }> } };

function sfv(v: string | number): FieldValue {
  if (typeof v === "number") {
    return { stringValue: Number.isInteger(v) ? v.toFixed(1) : String(v) };
  }
  return { stringValue: v };
}
const bfv = (v: boolean): FieldValue => ({ booleanValue: v });
const nfv = (): FieldValue => ({ nullValue: null });

function servingsArray(servings: MfFoodServing[]): FieldValue {
  return {
    arrayValue: {
      values: servings.map((s) => ({
        mapValue: {
          fields: {
            m: sfv(s.description),
            w: sfv(s.gramWeight),
            q: sfv(s.amount),
          },
        },
      })),
    },
  };
}

export interface LogTime {
  date: string; // YYYY-MM-DD (MacroFactor diary date)
  hour: number;
  minute: number;
}

export function toLogTime(d: Date): LogTime {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return {
    date: `${yyyy}-${mm}-${dd}`,
    hour: d.getHours(),
    minute: d.getMinutes(),
  };
}

/**
 * Log a food from the Typesense search results into the user's MacroFactor
 * diary. Always uses gram mode (quantity is in grams).
 *
 * Returns the entryId Firestore assigned (caller should persist it).
 */
export async function logFood(
  auth: MfAuth,
  food: MfFood,
  grams: number,
  loggedAt: LogTime,
): Promise<string> {
  const sg = grams; // in gram mode w=1, y=grams, q=1, u=g
  const nowMicros = String(Date.now() * 1000);
  const entryId = nowMicros;

  const fields: Record<string, FieldValue> = {
    t: sfv(food.name),
    b: sfv(food.brand || food.name),
    id: sfv(food.foodId),
    c: sfv((food.caloriesPer100g * sg) / 100),
    p: sfv((food.proteinPer100g * sg) / 100),
    e: sfv((food.carbsPer100g * sg) / 100),
    f: sfv((food.fatPer100g * sg) / 100),
    g: sfv(sg),
    w: sfv(1),
    y: sfv(grams),
    q: sfv(1),
    s: sfv("g"),
    u: sfv("g"),
    h: sfv(String(loggedAt.hour)),
    mi: sfv(String(loggedAt.minute)),
    k: sfv("t"),
    x: sfv(food.imageId || ""),
    ca: sfv(nowMicros),
    ua: sfv(nowMicros),
    o: bfv(false),
    fav: bfv(false),
    ef: nfv(),
    m: servingsArray(food.servings),
  };

  // Per-serving micronutrients (not c/p/e/f which we already set)
  for (const [nid, per100g] of Object.entries(food.nutrientsPer100g)) {
    if (["203", "204", "205", "208"].includes(nid)) continue;
    const perServing = (per100g * sg) / 100;
    if (perServing !== 0) fields[nid] = sfv(perServing);
  }

  await patchFoodEntry(auth, loggedAt.date, entryId, fields);
  return entryId;
}

/**
 * Log an estimated entry (no MacroFactor food matched). Uses k="n" (nutrition)
 * which the app accepts as a manual macro-only entry without an attached food.
 * Used as the fallback path when search returns nothing usable.
 */
export async function logEstimatedFood(
  auth: MfAuth,
  name: string,
  calories: number,
  protein: number,
  carbs: number,
  fat: number,
  loggedAt: LogTime,
): Promise<string> {
  const nowMicros = String(Date.now() * 1000);
  const entryId = nowMicros;
  const defaultServing: MfFoodServing = { description: "serving", gramWeight: 1, amount: 1 };
  const fields: Record<string, FieldValue> = {
    t: sfv(name),
    b: sfv(name),
    c: sfv(calories),
    p: sfv(protein),
    e: sfv(carbs),
    f: sfv(fat),
    g: sfv(1),
    w: sfv(1),
    y: sfv(1),
    q: sfv(1),
    s: sfv(defaultServing.description),
    u: sfv(defaultServing.description),
    h: sfv(String(loggedAt.hour)),
    mi: sfv(String(loggedAt.minute)),
    k: sfv("n"),
    ca: sfv(nowMicros),
    ua: sfv(nowMicros),
    o: bfv(false),
    fav: bfv(false),
    ef: nfv(),
    m: servingsArray([defaultServing]),
    id: sfv(entryId),
    x: sfv("229"),
  };
  await patchFoodEntry(auth, loggedAt.date, entryId, fields);
  return entryId;
}

async function patchFoodEntry(
  auth: MfAuth,
  date: string,
  entryId: string,
  fields: Record<string, FieldValue>,
): Promise<void> {
  const path = `users/${auth.uid}/food/${date}`;
  // Field paths containing only digits must be backtick-escaped per Firestore.
  const escaped = "`" + entryId + "`";
  const url = `${FIRESTORE_BASE}/${path}?updateMask.fieldPaths=${encodeURIComponent(escaped)}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.idToken}`,
    },
    body: JSON.stringify({
      fields: { [entryId]: { mapValue: { fields } } },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Firestore PATCH failed (${resp.status}): ${await resp.text()}`);
  }
}
