import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Vox Craft (craft.html): combine two items, Claude says what they make. Like Infinite Craft, every combination is
// worked out once and saved (craft_recipes), so it's the same for everyone and Claude is only asked about new pairs.
// Both items must already exist (craft_items: the 4 base items + everything discovered so far), so nobody can send
// Claude arbitrary text. New pairs are rate-limited (craft_log): 60 an hour per player, 1500 an hour site-wide.
// The Anthropic key is read from private_config with the service role and never leaves the server.
// Public on purpose (guests play too): verify_jwt is off. Refused while emergency mode is on.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELS = ["claude-haiku-5-5", "claude-haiku-4-5"];   // fast and cheap; the second is a fallback
const PER_PLAYER_HOUR = 60, SITE_HOUR = 1500;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You are the engine of a word-combining game like Infinite Craft. The player combines two things; you say the one thing they make.
Rules:
- Answer with one real thing, idea, place, creature, material or well-known fictional character: 1 to 3 words, at most 24 characters, Title Case.
- Be creative but logical, the way a clever person would guess (Fire + Water = Steam, Earth + Wind = Dust, Plant + Time = Tree).
- Only give back one of the two inputs if nothing else fits at all.
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

async function askClaude(apiKey: string, a: string, b: string): Promise<string | null> {
  for (const model of MODELS) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 60, system: SYSTEM, messages: [{ role: "user", content: `${a} + ${b}` }] }),
    });
    if (r.status === 404 || r.status === 400) continue;   // model not available on this account: try the next one
    if (!r.ok) return null;
    const data = await r.json();
    const text = (data?.content || []).map((c: { text?: string }) => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    try { return m ? String(JSON.parse(m[0]).result || "") : null; } catch { return null; }
  }
  return null;
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

  // already worked out: same answer for everyone
  const { data: known } = await admin.from("craft_recipes").select("result_key").eq("a", a).eq("b", b).maybeSingle();
  if (known) {
    const { data: it } = await admin.from("craft_items").select("name").eq("name_key", known.result_key).maybeSingle();
    return json({ result: it?.name || known.result_key, first: false });
  }

  // both must be real items (base or discovered), so nothing else ever reaches Claude
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

  const { data: k } = await admin.from("private_config").select("value").eq("key", "anthropic_api_key").maybeSingle();
  const apiKey = (k?.value as string) || "";
  if (!apiKey) return json({ error: "Not set up" }, 503);

  let out = await askClaude(apiKey, byKey.get(a)!, byKey.get(b)!);
  out = out ? titleCase(tidy(out.replace(/["“”`]/g, ""))) : "";
  if (!out || out.length > 24 || !/^[A-Za-z0-9][A-Za-z0-9 '\-]*$/.test(out) || BAD.test(out)) return json({ result: null });

  // save it (if two players made the same new pair at once, the first save wins and both get the same answer)
  const rk = keyOf(out);
  const { data: newItem } = await admin.from("craft_items").insert({ name_key: rk, name: out, first_by: uid }).select("name").maybeSingle();
  await admin.from("craft_recipes").insert({ a, b, result_key: rk });
  const { data: final } = await admin.from("craft_recipes").select("result_key").eq("a", a).eq("b", b).maybeSingle();
  const { data: it } = await admin.from("craft_items").select("name").eq("name_key", final?.result_key || rk).maybeSingle();
  return json({ result: it?.name || out, first: !!newItem && (final?.result_key || rk) === rk });
});
