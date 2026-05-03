import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Audio → text via OpenAI Whisper. The iOS Shortcut records audio and POSTs
// it as multipart/form-data with field `file` — same shape Whisper expects,
// so we just forward the body to OpenAI and pass the response through.
//
// Required secret: OPENAI_API_KEY

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY not configured" }, 500);

  try {
    // Read the inbound audio file from multipart, then re-pack into a fresh
    // FormData for OpenAI. We can't just pass req.body through because the
    // iOS Shortcut sends the file under whatever field name the user picked
    // and Whisper requires it to be exactly `file`.
    const inForm = await req.formData();
    let file: File | null = null;
    for (const [, value] of inForm.entries()) {
      if (value instanceof File) {
        file = value;
        break;
      }
    }
    if (!file) return json({ error: "No audio file in request" }, 400);

    const outForm = new FormData();
    outForm.append("file", file, file.name || "audio.m4a");
    outForm.append("model", "whisper-1");
    // Auto-detect language. Whisper handles Dutch + English mixed input well.
    // To force Dutch: outForm.append("language", "nl");
    outForm.append("response_format", "json");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: outForm,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Whisper error:", resp.status, errText);
      return json({ error: "Whisper API error", status: resp.status, details: errText }, 500);
    }
    const data = await resp.json();
    return json({ text: data.text ?? "" });
  } catch (e) {
    console.error("Transcribe error:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
