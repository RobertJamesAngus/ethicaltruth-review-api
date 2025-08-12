// api/review.js — EthicalTruth /review endpoint (Vercel, Node 20)
// Takes { x_url }, fetches tweet text + linked pages (best‑effort),
// runs a locked, deterministic prompt on OpenAI (and Grok if key present),
// merges results, returns JSON + a ready-to-post tweet.

import crypto from "node:crypto";
import fetch from "node-fetch";

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;     // required
const GROK_API_KEY   = process.env.GROK_API_KEY;       // optional
const MODEL_OPENAI   = process.env.MODEL_OPENAI || "gpt-4o-mini";
const MODEL_GROK     = process.env.MODEL_GROK   || "grok-2";
const REPORT_BASE    = process.env.REPORT_BASE  || "https://ethicaltruth.app/r";

// ---- Locked shared prompt (deterministic, evidence-only) ----
const SHARED_PROMPT = `
ROLE: Evidence‑only ethics analyst.

TASK: Evaluate claim(s) from the X post and its linked pages. Extract factual propositions; gather primary evidence; produce a neutral report.

RUBRIC: Truthfulness, Safety/Harm, Fairness/Bias, Transparency, Proportionality.

RULES:
- Evidence or omit. Each factual claim MUST include a ≤25‑word quote + public URL. If not available, omit the claim.
- Source hierarchy: official docs/regulators/courts → peer‑review → reputable news → company sites → other. Social posts are leads only.
- Two‑pass: (A) evidence collection + neutral analysis; (B) adversarial self‑critique. Keep only points that survive both.
- Label any inference as "Inference:" and require ≥2 independent sources.
- Refuse PII/doxxing/illegal content. No editorializing.
- Deterministic: temperature=0. Return JSON ONLY per schema. If insufficient evidence, verdict "Inconclusive" and list "known_unknowns".

INPUTS:
- tweet_text: {tweet_text}
- tweet_url: {tweet_url}
- extracted_links: {extracted_links}
- page_snapshots: {page_snapshots}

OUTPUT (JSON only):
{
  "case_id":"ET-xxxx",
  "claim_extract":[ "..."],
  "findings":[
    {"claim":"...", "status":"Supported|Contested|Rejected",
     "evidence":[{"quote":"...", "url":"...", "tier":"official|regulator|peerreview|news|company|other"}],
     "notes":"..."}
  ],
  "scores":{"truth":0-100,"safety":0-100,"bias":0-100,"transparency":0-100,"proportionality":0-100},
  "verdict":"<short label>",
  "confidence":0-100,
  "top_sources":["...","...","..."],
  "known_unknowns":["..."],
  "audit":{"prompt_version":"ET-v1.0","model_versions":{"self":"<model-id>"},"timestamp_utc":"YYYY-MM-DDThh:mm:ssZ"},
  "tweet_text":"(ignored here)"
}
`.trim();

// ---- helpers ----
const HIGH_TIERS = new Set(["official","regulator","peerreview"]);
const stripHtml = s => (s || "").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
const nowUTC = () => new Date().toISOString().replace(/\.\d+Z$/,"Z");
const sha256 = (...parts) => "sha256:" + parts
  .map(p => (typeof p === "string" ? p : JSON.stringify(p)))
  .reduce((h, p) => (h.update(p), h), crypto.createHash("sha256")).digest("hex");

function extractFirstStatusUrl(text="") {
  const m = text.match(/https?:\/\/(?:x|twitter)\.com\/[^\s]+\/status\/\d+/i);
  return m ? m[0] : null;
}

async function fetchTweetText(xUrl) {
  try {
    const r = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(xUrl)}`);
    if (!r.ok) throw new Error("oembed fail");
    const { html } = await r.json();
    return stripHtml(html);
  } catch { return ""; }
}

async function fetchPageSnapshot(url) {
  try {
    const r = await fetch(url, { redirect:"follow", headers:{ "User-Agent":"EthicalTruthBot/1.0" } });
    if (!r.ok) throw new Error(String(r.status));
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [,""])[1].trim().slice(0,200);
    const ps = Array.from(html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)).map(m => stripHtml(m[1])).filter(Boolean);
    const [snippet1="", snippet2=""] = [ps[0]||"", ps[1]||""].map(s => s.slice(0,300));
    return { url, title, snippet1, snippet2 };
  } catch { return { url, title:"", snippet1:"", snippet2:"" }; }
}

function renderPrompt(payload){
  return SHARED_PROMPT
    .replace("{tweet_text}", JSON.stringify(payload.tweet_text))
    .replace("{tweet_url}", JSON.stringify(payload.tweet_url))
    .replace("{extracted_links}", JSON.stringify(payload.extracted_links))
    .replace("{page_snapshots}", JSON.stringify(payload.page_snapshots));
}

async function callOpenAI(prompt){
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      model: MODEL_OPENAI, temperature: 0, response_format: { type: "json_object" },
      messages:[{ role:"user", content: prompt }]
    })
  });
  if(!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || "{}";
  const out = JSON.parse(content);
  out.audit ||= {}; out.audit.prompt_version="ET-v1.0";
  out.audit.model_versions ||= {}; out.audit.model_versions.self = MODEL_OPENAI;
  out.audit.timestamp_utc = nowUTC();
  return out;
}

async function callGrok(prompt){
  if(!GROK_API_KEY) return null;
  const r = await fetch("https://api.x.ai/v1/chat/completions",{
    method:"POST",
    headers:{ Authorization:`Bearer ${GROK_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      model: MODEL_GROK, temperature: 0, response_format: { type: "json_object" },
      messages:[{ role:"user", content: prompt }]
    })
  });
  if(!r.ok) throw new Error(`Grok ${r.status}`);
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || "{}";
  const out = JSON.parse(content);
  out.audit ||= {}; out.audit.prompt_version="ET-v1.0";
  out.audit.model_versions ||= {}; out.audit.model_versions.self = MODEL_GROK;
  out.audit.timestamp_utc = nowUTC();
  return out;
}

// merge
function dedupeEvidence(list=[]){
  const seen=new Set(), out=[];
  for(const e of list){
    const key = `${(e.quote||"").trim()}|${(e.url||"").trim()}`;
    if(seen.has(key)) continue; seen.add(key);
    out.push({ quote:(e.quote||"").trim(), url:(e.url||"").trim(), tier:e.tier||"other" });
  }
  return out;
}
function mergeFindings(grok,gpt){
  const bucket=new Map();
  for(const r of [grok,gpt]){ if(!r) continue;
    for(const f of (r.findings||[])){
      const c=(f.claim||"").trim();
      if(!bucket.has(c)) bucket.set(c,{e:[], s:new Set()});
      const cell=bucket.get(c);
      (f.evidence||[]).forEach(ev=>cell.e.push(ev));
      cell.s.add(f.status||"Contested");
    }
  }
  const out=[];
  for(const [claim,cell] of bucket.entries()){
    const ev=dedupeEvidence(cell.e);
    const high=ev.filter(e=>HIGH_TIERS.has(e.tier)).length;
    const onlySupported = cell.s.size===1 && cell.s.has("Supported");
    let status="Rejected";
    if(high>=2 && onlySupported) status="Supported";
    else if(high>=1) status="Contested";
    out.push({ claim, status, evidence: ev });
  }
  const order={Supported:0,Contested:1,Rejected:2};
  out.sort((a,b)=>(order[a.status]-order[b.status]) || (b.evidence.length-a.evidence.length));
  return out;
}
const deriveVerdict = m => m.some(f=>f.status==="Supported") ? "Supported claims with safety basis" :
                           m.every(f=>f.status==="Rejected") ? "Inconclusive" :
                           "Mixed evidence; further review needed";
const confidenceOf = m => {
  const t=Math.max(m.length,1);
  const sup=m.filter(f=>f.status==="Supported").length;
  const con=m.filter(f=>f.status==="Contested").length;
  let c=(sup/t)*0.9 - (con/t)*0.2;
  return Math.max(0,Math.min(0.95,+c.toFixed(4)));
};
const topSources = (m,k=3) => {
  const urls=[]; m.forEach(f=>f.evidence.forEach(e=>{ if(e.url && !urls.includes(e.url)) urls.push(e.url); }));
  return urls.slice(0,k);
};

// ---- HTTP handler ----
export default async function handler(req, res){
  try{
    if(req.method !== "POST"){
      return res.status(405).json({ error:"Use POST with JSON { x_url }" });
    }
    const body = req.body || (await (async()=>{ try { return await req.json(); } catch { return {}; } })());
    const xUrl = (body?.x_url || "").trim();
    if(!xUrl) return res.status(400).json({ error:"x_url required" });

    // tweet + links
    const tweet_text = await fetchTweetText(xUrl);
    const foundUrl = extractFirstStatusUrl(tweet_text) || xUrl;
    const linkMatches = tweet_text.match(/https?:\/\/[^\s)]+/g) || [];
    const extracted_links = [...new Set(linkMatches.filter(u => !u.includes("/status/")).slice(0,3))];

    const page_snapshots=[];
    for(const u of extracted_links.slice(0,3)){
      page_snapshots.push(await fetchPageSnapshot(u));
    }

    const prompt = renderPrompt({ tweet_text, tweet_url: foundUrl, extracted_links, page_snapshots });

    const outputs=[];
    const gpt  = await callOpenAI(prompt); outputs.push(gpt);
    let grok=null; if(GROK_API_KEY){ try{ grok=await callGrok(prompt); outputs.push(grok); } catch{} }

    const merged = mergeFindings(grok,gpt);
    const verdict = deriveVerdict(merged);
    const confidence = confidenceOf(merged);
    const sources = topSources(merged,3);

    const case_id = gpt.case_id || (grok && grok.case_id) || ("ET-" + crypto.randomBytes(4).toString("hex").toUpperCase());
    const report_url = `${REPORT_BASE}/${case_id}`;
    const tweet_text_out =
      `EthicalTruth Review · Case ${case_id} — Verdict: ${verdict}. ` +
      `Confidence ${Math.round(confidence*100)}%. Sources: ${sources.map(u=>u.replace(/^https?:\/\//,"").split("/")[0]).join(", ")}. ` +
      `Full: ${report_url}`;

    const result = {
      case_id, verdict, confidence,
      findings: merged,
      scores: gpt.scores || {},
      top_sources: sources,
      known_unknowns: Array.from(new Set([...(gpt.known_unknowns||[]), ...((grok&&grok.known_unknowns)||[])])),
      tweet_text: tweet_text_out,
      report_url,
      hash: sha256(xUrl, prompt, outputs)
    };

    return res.status(200).json(result);
  } catch(e){
    console.error(e);
    return res.status(422).json({ error: e.message || "Internal error", verdict:"Inconclusive",
      known_unknowns:["Failed to fetch sources or model output invalid."] });
  }
}
