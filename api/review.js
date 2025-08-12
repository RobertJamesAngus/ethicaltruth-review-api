// POST /api/review
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST with JSON body { x_url }" });

  try {
    const { x_url } = req.body || {};
    if (!x_url || typeof x_url !== "string") return res.status(400).json({ error: "Missing x_url string" });
    if (!/^https?:\/\/(x\.com|twitter\.com)\/.+/i.test(x_url))
      return res.status(400).json({ error: "x_url must be an X/Twitter link" });

    const key = process.env.OPENAI_API_KEY;
    const model = process.env.MODEL_OPENAI || "gpt-4o-mini";
    if (!key) return res.status(500).json({ error: "OPENAI_API_KEY not set" });

    const system =
      'You are EthicalTruth. Return STRICT JSON only: ' +
      '{"verdict":"Supported|Unsupported|Inconclusive","confidence":0.0,"tweet_text":"string"}';

    const user = `Evaluate the public post at this URL: ${x_url}
Return only the JSON object, no extra text.`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: "OpenAI error", details: err });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let json;
    try { json = JSON.parse(content); }
    catch { json = { verdict: "Inconclusive", confidence: 0.0, tweet_text: "" }; }

    return res.status(200).json({ case_id: `ET-${Date.now()}`, ...json, source_url: x_url });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
