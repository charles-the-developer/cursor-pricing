const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3847;
const HTML_PATH = path.join(__dirname, "cursor_pricing.html");

const WANTED_MODELS = [
  "GPT-5.3 Codex",
  "Grok 4.5",
  "GPT-5.6 Sol",
  "GPT-5.6 Terra",
  "GPT-5.6 Luna",
  "Composer 2.5",
  "Kimi K2.7 Code",
  "Claude Opus 4.8",
  "Claude Opus 5",
  "Claude Sonnet 5",
  "Claude Haiku 4.5"
];

const PRICING_PAGE_URL = "https://cursor.com/docs/models-and-pricing";

// Composer 2.5 and Grok 4.5 are Cursor's own "Cursor Models" pool. Their pricing
// renders through a client-side component on the docs page's "Grok 4.5 pricing"
// / "Composer pricing" sections and is never present as scrapable text (web
// search over the page can't see it either), so we can't ask Claude to find it.
// Values captured by hand on 2026-08-03 -- if they look off, recheck them at
// PRICING_PAGE_URL.
const CURSOR_MODELS_POOL_PRICING = {
  "Composer 2.5": { input: 0.5, cache_write: null, cache_read: 0.2, output: 2.5 },
  "Grok 4.5": { input: 2.0, cache_write: null, cache_read: 0.5, output: 6.0 }
};

const SCRAPABLE_MODELS = WANTED_MODELS.filter((name) => !(name in CURSOR_MODELS_POOL_PRICING));

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function buildSystemPrompt() {
  return (
    "You are a data extraction tool. Use web search to find current pricing on the page " +
    "https://cursor.com/docs/models-and-pricing (and cursor.com/docs/models-and-usage/available-models, " +
    "https://cursor.com/docs/models/kimi-k2-7-code, or other model-specific pages under cursor.com/docs/models/ if needed). " +
    "Find per-million-token pricing (USD) for EXACTLY these models, matching as closely " +
    "as possible even if Cursor's page uses slightly different naming or lists variants (e.g. 'Fast'): " +
    JSON.stringify(SCRAPABLE_MODELS) +
    ". " +
    "For each model, extract: input price, cache write price, cache read price, and output price " +
    "(all per million tokens). Not every model has cache write/read rates — use null if the page doesn't list one. " +
    "Respond with ONLY a raw JSON array, no markdown fences, no commentary. Each element: " +
    '{"name": string (one of the requested names), "variant": string or null (e.g. "Fast", "Standard", null if only one rate), ' +
    '"input": number or null, "cache_write": number or null, "cache_read": number or null, "output": number or null, ' +
    '"note": string or null (VERY short caveat, max ~10 words, e.g. "requires Max Mode" or "not found on pricing page" ' +
    'or "1M context surcharge applies" — omit if nothing notable)}. ' +
    "If a model has both Standard and Fast pricing, include two objects (one per variant). " +
    "If a requested model cannot be found on Cursor's pricing page at all, still include one object for it with " +
    'all price fields set to null and a note saying it was not found. Return exactly one entry per requested model at minimum.'
  );
}

function parsePricingFromResponse(data) {
  const textParts = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const cleaned = textParts.replace(/```json/gi, "").replace(/```/g, "").trim();
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse pricing data from the response.");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Empty result.");
    }
    return parsed;
  } catch (parseErr) {
    const objMatches = jsonMatch[0].match(/\{[^{}]*\}/g);
    if (!objMatches || objMatches.length === 0) throw parseErr;

    const salvaged = objMatches
      .map((segment) => {
        try {
          return JSON.parse(segment);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (salvaged.length === 0) throw parseErr;
    return salvaged;
  }
}

async function fetchPricing() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key."
    );
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: buildSystemPrompt(),
      messages: [
        { role: "user", content: "Fetch the current pricing for the requested models now." }
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || `Anthropic API error (${response.status})`;
    throw new Error(message);
  }

  return mergeCursorModelsPoolPricing(parsePricingFromResponse(data));
}

function mergeCursorModelsPoolPricing(scrapedModels) {
  const overrides = Object.entries(CURSOR_MODELS_POOL_PRICING).map(([name, prices]) => ({
    name,
    variant: null,
    ...prices,
    note: `Not in Cursor's scrapable pricing table (Cursor Models pool) -- verify at ${PRICING_PAGE_URL}`
  }));

  const byWantedOrder = (a, b) => WANTED_MODELS.indexOf(a.name) - WANTED_MODELS.indexOf(b.name);
  return [...scrapedModels, ...overrides].sort(byWantedOrder);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/cursor_pricing.html")) {
    try {
      const html = fs.readFileSync(HTML_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: "Failed to read cursor_pricing.html" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pricing") {
    try {
      const models = await fetchPricing();
      sendJson(res, 200, { models });
    } catch (err) {
      console.error("[PRICING]", err.message);
      sendJson(res, 500, { error: err.message || "Failed to fetch pricing." });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

loadEnvFile();

server.listen(PORT, () => {
  console.log(`cursor_pricing running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. Create a .env file before refreshing.");
  }
});
