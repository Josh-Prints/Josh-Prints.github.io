import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Vox Craft (craft.html): combine two items, an AI says what they make. Like Infinite Craft, every combination is
// worked out once and saved (craft_recipes), so it's the same for everyone and the AI is only asked about new pairs.
// Both items must already exist (craft_items: the 4 base items + everything discovered so far), so nobody can send
// the AI arbitrary text. New pairs are rate-limited (craft_log): 60 an hour per player, 1500 an hour site-wide.
// Provider + model are picked in Founder > AI (private_config craft_provider / craft_model; keys groq_api_key,
// xai_api_key, anthropic_api_key, read with the service role, never sent to a browser). If a model fails or gives a
// bad answer the next one is tried (rest of that provider's list, then the other providers with a key), and if
// everything fails the two names are joined, so a combination always makes something.
// Public on purpose (guests play too): verify_jwt is off. Refused while emergency mode is on or for banned accounts.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PER_PLAYER_HOUR = 60, SITE_HOUR = 1500;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// fallback order when the chosen model doesn't work (keep in step with the list in admin/founder.html)
const MODELS: Record<string, string[]> = {
  groq: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct",
    "openai/gpt-oss-20b", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b", "gemma2-9b-it", "llama3-8b-8192", "llama3-70b-8192"],
  xai: ["grok-4-fast-non-reasoning", "grok-4-1-fast-non-reasoning", "grok-3-mini", "grok-3-mini-fast", "grok-3", "grok-3-fast", "grok-4-fast-reasoning", "grok-4", "grok-2-1212"],
  anthropic: ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-4-5", "claude-3-5-haiku-latest"],
};
const URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
};
const KEYS: Record<string, string> = { groq: "groq_api_key", xai: "xai_api_key", anthropic: "anthropic_api_key" };

const SYSTEM = `You are the engine of a word-combining game like Infinite Craft. The player combines two things; you say the one thing they make.
Rules:
- Always answer with something. Never refuse, never say nothing, never answer "nothing" or "none".
- One real thing, idea, place, creature, material or well-known fictional character: 1 to 3 words, at most 24 characters, Title Case.
- Be creative but logical, the way a clever person would guess (Fire + Water = Steam, Earth + Wind = Dust, Plant + Time = Tree).
- Prefer something new; only give back one of the inputs if nothing else fits at all.
- Family friendly: nothing sexual, no slurs or hate, no drugs, no gore, no real living people.
- No emoji, no quotes, no punctuation other than a hyphen or apostrophe.
Reply with JSON only, exactly like {"result": "Steam"}.`;

const BAD = /\b(sex|porn|nude|naked|rape|nazi|hitler|cocaine|heroin|meth|weed|penis|vagina|boob|fuck|shit|bitch|cunt|dick|cock|whore|slut|nigg|fag|retard|kill yourself|suicide)/i;
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const keyOf = (s: string) => tidy(s).toLowerCase();
function titleCase(s: string) {
  return s.split(" ").map((w) => (/^(of|the|and|in|on|a|an|to|de)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}
// a usable answer, or null
function clean(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  let r: string | null = null;
  const m = text.match(/\{[^{}]*"result"[^{}]*\}/);
  if (m) { try { r = String(JSON.parse(m[0]).result || ""); } catch { r = null; } }
  if (!r) { const q = text.match(/"result"\s*:\s*"([^"]+)"/); r = q ? q[1] : null; }
  if (!r) return null;
  const out = titleCase(tidy(r.replace(/["“”`.!]/g, "")));
  if (!out || out.length > 24 || !/^[A-Za-z0-9][A-Za-z0-9 '\-]*$/.test(out) || BAD.test(out) || /^(nothing|none|null|n\/a)$/i.test(out)) return null;
  return out;
}

async function ask(provider: string, model: string, key: string, a: string, b: string): Promise<string | null> {
  const user = `${a} + ${b}`;
  try {
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(9000),
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 60, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      return clean((d?.content || []).map((c: { text?: string }) => c.text || "").join(""));
    }
    const r = await fetch(URLS[provider], {
      method: "POST", signal: AbortSignal.timeout(9000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.7, max_tokens: 400, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return clean(String(d?.choices?.[0]?.message?.content || ""));
  } catch { return null; }   // timeout or network: try the next model
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { a?: string; b?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const ra = tidy(String(body.a || "")), rb = tidy(String(body.b || ""));
  if (!ra || !rb || ra.length > 40 || rb.length > 40) return json({ error: "Pick two items" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: em } = await admin.from("site_emergency").select("active").eq("id", 1).maybeSingle();
  if (em?.active) return json({ error: "Paused" }, 503);

  const [a, b] = [keyOf(ra), keyOf(rb)].sort();

  // already made: always the same answer, for everyone
  const { data: known } = await admin.from("craft_recipes").select("result_key").eq("a", a).eq("b", b).maybeSingle();
  if (known) {
    const { data: it } = await admin.from("craft_items").select("name").eq("name_key", known.result_key).maybeSingle();
    return json({ result: it?.name || known.result_key, first: false });
  }

  // both must be real items (base or discovered), so nothing else ever reaches the AI
  const { data: items } = await admin.from("craft_items").select("name_key, name").in("name_key", [a, b]);
  const byKey = new Map((items || []).map((i: { name_key: string; name: string }) => [i.name_key, i.name]));
  if (!byKey.has(a) || !byKey.has(b)) return json({ error: "Unknown item" }, 400);

  // who's asking (signed-in players get credit for first discoveries; guests are rate-limited by IP)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let uid: string | null = null;
  if (/^eyJ/.test(bearer)) { const { data } = await admin.auth.getUser(bearer); uid = data?.user?.id || null; }
  if (uid) {   // banned accounts can't play (like every other game)
    const { data: cp } = await admin.from("customer_profiles").select("banned_at").eq("id", uid).maybeSingle();
    if (cp?.banned_at) return json({ error: "Account banned" }, 403);
  }
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const who = uid ? "u:" + uid : "ip:" + ip;
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    admin.from("craft_log").select("id", { count: "exact", head: true }).eq("who", who).gte("at", since),
    admin.from("craft_log").select("id", { count: "exact", head: true }).gte("at", since),
  ]);
  if ((mine || 0) >= PER_PLAYER_HOUR || (all || 0) >= SITE_HOUR) return json({ error: "Too fast. Try again soon." }, 429);
  await admin.from("craft_log").insert({ who });

  // the chosen provider + model first, then everything else that has a key
  const { data: cfg } = await admin.from("private_config").select("key, value")
    .in("key", ["craft_provider", "craft_model", "groq_api_key", "xai_api_key", "anthropic_api_key"]);
  const get = (k: string) => String((cfg || []).find((c: { key: string }) => c.key === k)?.value || "").trim();
  const chosen = MODELS[get("craft_provider")] ? get("craft_provider") : "groq";
  const tries: [string, string][] = [];
  for (const p of [chosen, ...Object.keys(MODELS).filter((x) => x !== chosen)]) {
    if (!get(KEYS[p])) continue;
    const list = MODELS[p].slice();
    if (p === chosen && get("craft_model")) list.unshift(get("craft_model"));
    for (const m of [...new Set(list)].slice(0, p === chosen ? 6 : 2)) tries.push([p, m]);
  }
  let out: string | null = null, used = "";
  const started = Date.now();
  for (const [p, m] of tries) {
    if (Date.now() - started > 20000) break;   // stay well inside the function time limit
    out = await ask(p, m, get(KEYS[p]), byKey.get(a)!, byKey.get(b)!);
    if (out) { used = p + ":" + m; break; }
  }
  // nothing worked: join the two names, so a combination still always makes something
  if (!out) { out = titleCase((byKey.get(a)! + " " + byKey.get(b)!).slice(0, 24).trim()); used = "joined"; }

  // save it (if two players made the same new pair at once, the first save wins and both get the same answer)
  const rk = keyOf(out);
  const { data: newItem } = await admin.from("craft_items").insert({ name_key: rk, name: out, first_by: uid }).select("name").maybeSingle();
  await admin.from("craft_recipes").insert({ a, b, result_key: rk, made_by: used });
  const { data: final } = await admin.from("craft_recipes").select("result_key").eq("a", a).eq("b", b).maybeSingle();
  const { data: it } = await admin.from("craft_items").select("name").eq("name_key", final?.result_key || rk).maybeSingle();
  return json({ result: it?.name || out, first: !!newItem && (final?.result_key || rk) === rk });
});
