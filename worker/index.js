// RECALL tutor proxy — Cloudflare Worker
// Receives tutor requests from the PWA and forwards them to Anthropic.
// The ANTHROPIC_API_KEY is stored as a Worker secret (never in source code).
//
// Deploy: paste this file into the Cloudflare Worker editor, then add
// ANTHROPIC_API_KEY as a secret via Settings → Variables → Secret.

const ALLOWED_ORIGIN = "https://utkusama0.github.io";
const ANTHROPIC_API   = "https://api.anthropic.com/v1/messages";
// Allow any Claude model. Prefix check avoids brittle exact-match maintenance
// while still blocking abuse (only Anthropic Claude models can be requested).
function isAllowedModel(m) {
  return typeof m === "string" && m.startsWith("claude-");
}

function corsHeaders(origin) {
  // Only allow requests from the GitHub Pages origin.
  const allow = origin === ALLOWED_ORIGIN ? origin : "null";
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only POST allowed
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Block requests not coming from the app
    if (origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const { model, system, user, max_tokens } = body;

    // Claude models only — reject anything else
    if (!isAllowedModel(model)) {
      return new Response(JSON.stringify({ error: "Model not allowed" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Validate required fields
    if (!system || !user) {
      return new Response(JSON.stringify({ error: "Missing system or user" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Forward to Anthropic — key comes from Worker secret, never from the request
    const anthropicRes = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.min(max_tokens || 800, 1500),
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      return new Response(JSON.stringify({ error: err }), {
        status: anthropicRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const j = await anthropicRes.json();
    const text = j.content?.[0]?.text || "";

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  },
};
