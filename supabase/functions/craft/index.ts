import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Vox Craft (craft.html): combine two items, Groq says what they make. Like Infinite Craft, every combination is
// worked out once and saved (craft_recipes), so it's the same for everyone and Groq is only asked about new pairs.
// Both items must already exist (craft_items: the 4 base items + everything discovered so far), so nobody can send
// the AI arbitrary text.
//
// Groq only. Model + keys are set in Founder > AI > Vox Craft (private_config craft_model; groq_api_key holds one key
// per line, read with the service role, never sent to a browser). Keys are used in turn; a key Groq rate-limits is
// rested for as long as Groq says (craft_key_wait) and the next key is tried. If every key is resting, the reply is
// { wait: seconds } and the page shows a faint countdown, then tries again by itself.
// Many players at once: a new pair being worked out is marked in craft_pending, so anyone else asking for the same pair
// waits for that answer instead of asking Groq again.
// A bad or missing answer falls through to the next model; if every model fails (not a rate limit) the two names are
// joined, so a combination always makes something.
// Our own limits (new pairs only; known pairs are free): 20 a minute and 400 an hour per player, 3000 an hour site-wide
// (craft_log); hitting one gives { wait } for just as long as that window needs.
// Public on purpose (guests play too): verify_jwt is off. Refused while emergency mode is on or for banned accounts.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PER_PLAYER_MIN = 20, PER_PLAYER_HOUR = 400, SITE_HOUR = 3000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// fallback order when the chosen model doesn't work (keep in step with the list in admin/founder.html)
// (Oct 2026: Groq only serves gpt-oss, qwen3.8 and allam for chat on these keys; the older ones stay last in case they come back)
const MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "allam-2-7b",
  "llama-3.1-8b-instant", "llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b", "moonshotai/kimi-k2-instruct"];
const GROQ = "https://api.groq.com/openai/v1/chat/completions";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
// "1m26.4s" / "7.66s" / "120ms" / "30" -> seconds
function seconds(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  let t = 0, hit = false;
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) { hit = true; t += Number(n) * (u === "h" ? 3600 : u === "m" ? 60 : u === "ms" ? 0.001 : 1); }
  return hit ? t : null;
}
async function keyId(k: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Ask = { out: string | null; limited?: number; bad?: boolean };
async function ask(model: string, key: string, a: string, b: string): Promise<Ask> {
  try {
    const r = await fetch(GROQ, {
      method: "POST", signal: AbortSignal.timeout(9000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.7, max_tokens: 400, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `${a} + ${b}` }],
        // thinking models: think as little as possible (much faster) and keep the thinking out of the reply
        ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : /qwen/.test(model) ? { reasoning_format: "hidden" } : {}) }),
    });
    if (r.status === 429) {   // rate limited: how long Groq wants us to wait
      const body = await r.text().catch(() => "");
      const msg = body.match(/try again in ([0-9hms.]+)/i);
      const w = seconds(r.headers.get("retry-after")) ?? seconds(msg && msg[1]) ??
        seconds(r.headers.get("x-ratelimit-reset-requests")) ?? seconds(r.headers.get("x-ratelimit-reset-tokens")) ?? 10;
      return { out: null, limited: Math.min(3600, Math.max(1, Math.ceil(w))) };
    }
    if (r.status === 401 || r.status === 403) return { out: null, bad: true };   // this key doesn't work
    if (!r.ok) return { out: null };                                              // model missing / busy: next model
    const d = await r.json();
    return { out: clean(String(d?.choices?.[0]?.message?.content || "")) };
  } catch { return { out: null }; }   // timeout or network: next model
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
  const known = async () => {
    const { data: rec } = await admin.from("craft_recipes").select("result_key").eq("a", a).eq("b", b).maybeSingle();
    if (!rec) return null;
    const { data: it } = await admin.from("craft_items").select("name").eq("name_key", rec.result_key).maybeSingle();
    return (it?.name as string) || rec.result_key;
  };

  // already made: always the same answer, for everyone
  const done = await known();
  if (done) return json({ result: done, first: false });

  // both must be real items (base or discovered), so nothing else ever reaches the AI
  const { data: items } = await admin.from("craft_items").select("name_key, name").in("name_key", [a, b]);
  const byKey = new Map((items || []).map((i: { name_key: string; name: string }) => [i.name_key, i.name]));
  if (!byKey.has(a) || !byKey.has(b)) return json({ error: "Unknown item" }, 400);

  // who's asking (signed-in players get credit for first discoveries; guests are counted by IP)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let uid: string | null = null;
  if (/^eyJ/.test(bearer)) { const { data } = await admin.auth.getUser(bearer); uid = data?.user?.id || null; }
  if (uid) {   // banned accounts can't play (like every other game)
    const { data: cp } = await admin.from("customer_profiles").select("banned_at").eq("id", uid).maybeSingle();
    if (cp?.banned_at) return json({ error: "Account banned" }, 403);
  }

  // someone else is already working this pair out: wait for their answer (many players, one Groq call)
  const { data: claimed } = await admin.from("craft_pending").insert({ a, b }).select("a").maybeSingle();
  if (!claimed) {
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const r = await known(); if (r) return json({ result: r, first: false });
    }
    const { data: p } = await admin.from("craft_pending").select("started_at").eq("a", a).eq("b", b).maybeSingle();
    if (p && Date.now() - new Date(p.started_at as string).getTime() < 30000) return json({ wait: 3 });
    await admin.from("craft_pending").upsert({ a, b, started_at: new Date().toISOString() });   // the other try died: take over
  }
  const release = () => admin.from("craft_pending").delete().eq("a", a).eq("b", b).then(() => {}, () => {});

  // our own limits
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const who = uid ? "u:" + uid : "ip:" + ip;
  // wait until the window has room again: the entry that has to drop out is the (count - limit + 1)th oldest in it
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const [mineQ, allQ] = await Promise.all([
    admin.from("craft_log").select("at").eq("who", who).gte("at", since).order("at", { ascending: false }).limit(PER_PLAYER_HOUR),
    admin.from("craft_log").select("at").gte("at", since).order("at", { ascending: false }).range(SITE_HOUR - 1, SITE_HOUR - 1),   // the 3000th newest, if any (row caps stop us fetching them all)
  ]);
  const mine = (mineQ.data || []).map((r: { at: string }) => new Date(r.at).getTime());   // newest first
  const all = (allQ.data || []).map((r: { at: string }) => new Date(r.at).getTime());
  const lastMin = mine.filter((t) => t > Date.now() - 60 * 1000);
  let freeAt = 0;
  if (lastMin.length >= PER_PLAYER_MIN) freeAt = Math.max(freeAt, lastMin[PER_PLAYER_MIN - 1] + 60 * 1000);
  if (mine.length >= PER_PLAYER_HOUR) freeAt = Math.max(freeAt, mine[PER_PLAYER_HOUR - 1] + 3600 * 1000);
  if (all.length) freeAt = Math.max(freeAt, all[0] + 3600 * 1000);
  if (freeAt > Date.now()) {
    await release();
    return json({ wait: Math.max(1, Math.ceil((freeAt - Date.now()) / 1000)) });
  }

  // Groq keys (one per line) and the chosen model
  const { data: cfg } = await admin.from("private_config").select("key, value").in("key", ["craft_model", "groq_api_key"]);
  const get = (k: string) => String((cfg || []).find((c: { key: string }) => c.key === k)?.value || "").trim();
  const keys = [...new Set(get("groq_api_key").split(/[\s,]+/).map((k) => k.trim()).filter((k) => k.length > 10))];
  if (!keys.length) { await release(); return json({ error: "Not set up" }, 503); }
  const ids = await Promise.all(keys.map(keyId));
  const { data: waits } = await admin.from("craft_key_wait").select("key_id, until").in("key_id", ids);
  const restUntil = new Map<string, number>((waits || []).map((w: { key_id: string; until: string }) => [w.key_id, new Date(w.until).getTime()]));
  const ready = () => keys.map((k, i) => ({ k, id: ids[i] })).filter((x) => (restUntil.get(x.id) || 0) <= Date.now());
  const models = [...new Set([get("craft_model"), ...MODELS].filter(Boolean))].slice(0, 6);

  await admin.from("craft_log").insert({ who });
  let out: string | null = null, used = "", turn = Math.floor(Math.random() * keys.length);
  const started = Date.now();
  outer: for (const model of models) {
    while (true) {
      if (Date.now() - started > 20000) break outer;   // stay well inside the function time limit
      const free = ready();
      if (!free.length) break outer;                   // every key is resting
      const pick = free[turn++ % free.length];
      const r = await ask(model, pick.k, byKey.get(a)!, byKey.get(b)!);
      if (r.limited || r.bad) {                         // rest this key and try the next one on the same model
        const until = Date.now() + (r.limited ? r.limited * 1000 : 3600 * 1000);
        restUntil.set(pick.id, until);
        await admin.from("craft_key_wait").upsert({ key_id: pick.id, until: new Date(until).toISOString() });
        continue;
      }
      if (r.out) { out = r.out; used = "groq:" + model; break outer; }
      break;                                            // no usable answer from this model: next model
    }
  }

  if (!out && !ready().length) {   // rate limited everywhere: tell the page how long, it shows a countdown and tries again
    await release();
    const soonest = Math.min(...ids.map((id) => restUntil.get(id) || Date.now()));
    return json({ wait: Math.max(1, Math.ceil((soonest - Date.now()) / 1000)) });
  }
  // every model failed: join the two names, so a combination still always makes something
  if (!out) { out = titleCase((byKey.get(a)! + " " + byKey.get(b)!).slice(0, 24).trim()); used = "joined"; }

  // save it (if two players somehow made the same new pair at once, the first save wins and both get the same answer)
  const rk = keyOf(out);
  const { data: newItem } = await admin.from("craft_items").insert({ name_key: rk, name: out, first_by: uid }).select("name").maybeSingle();
  await admin.from("craft_recipes").insert({ a, b, result_key: rk, made_by: used });
  await release();
  const final = await known();
  return json({ result: final || out, first: !!newItem && keyOf(final || out) === rk });
});
