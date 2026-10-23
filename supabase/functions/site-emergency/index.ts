import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Emergency mode switch (Founder > Settings). Turning it on or off needs a signed-in founder AND the site master key.
// The key lives only in the SITE_MASTER_KEY function secret (Supabase dashboard > Edge Functions > Secrets), never in
// the database or the repo, so a database leak can't reveal it. Wrong keys are counted: 5 misses in 15 minutes from one
// founder (or 20 from anyone) locks the switch for 15 minutes. Every attempt is logged in site_emergency_attempts.
//   action "on":  { key, title, report }  pauses the site, copies everyone's data into the private secure_store schema and
//                 signs everyone out except founders (rpc emergency_lockdown; see migrations/emergency-mode-migration.sql)
//   action "off": { key }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// compare the typed key with the secret without leaking timing: hash both, then compare every byte
async function sameKey(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { action?: string; key?: string; title?: string; report?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = body.action;
  if (action !== "on" && action !== "off") return json({ error: "Unknown action" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = /^eyJ/.test(bearer) ? await admin.auth.getUser(bearer) : { data: null };
  const uid = who?.user?.id;
  if (!uid) return json({ error: "Sign in first" }, 401);
  const { data: prof } = await admin.from("admin_profiles").select("is_founder, suspended_until").eq("id", uid).maybeSingle();
  const suspended = !!prof?.suspended_until && new Date(prof.suspended_until as string).getTime() > Date.now();
  if (!prof?.is_founder || suspended) return json({ error: "Founders only" }, 403);

  const secret = Deno.env.get("SITE_MASTER_KEY") || "";
  if (secret.length < 8) return json({ error: "Master key isn't set up" }, 503);

  // lockout after repeated wrong keys
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    admin.from("site_emergency_attempts").select("id", { count: "exact", head: true }).eq("ok", false).eq("user_id", uid).gte("at", since),
    admin.from("site_emergency_attempts").select("id", { count: "exact", head: true }).eq("ok", false).gte("at", since),
  ]);
  if ((mine || 0) >= 5 || (all || 0) >= 20) return json({ error: "Too many wrong keys. Try again in 15 minutes." }, 429);

  const ok = await sameKey(String(body.key || ""), secret);
  await admin.from("site_emergency_attempts").insert({ user_id: uid, ok, action });
  if (!ok) return json({ error: "Wrong master key" }, 403);

  const now = new Date().toISOString();
  let row, lockdown: Record<string, unknown> | null = null;
  if (action === "on") {
    const title = String(body.title || "").trim().slice(0, 80);
    const report = String(body.report || "").trim().slice(0, 4000);
    if (!title) return json({ error: "Add a title" }, 400);
    ({ data: row } = await admin.from("site_emergency").update({
      active: true, title, report, started_at: now, ended_at: null, changed_by: uid, updated_at: now,
    }).eq("id", 1).select().single());
    // copy everyone's data into the private secure_store schema and sign everyone out (founders stay signed in)
    const { data: ld, error: le } = await admin.rpc("emergency_lockdown", { p_reason: title });
    lockdown = le ? { error: le.message } : ld;
  } else {
    ({ data: row } = await admin.from("site_emergency").update({
      active: false, ended_at: now, changed_by: uid, updated_at: now,
    }).eq("id", 1).select().single());
  }

  // tell the admins on Discord (never blocks the switch)
  try {
    const { data: cfg } = await admin.from("private_config").select("key, value").in("key", ["discord_webhook_url", "discord_role_id"]);
    const get = (k: string) => (cfg || []).find((c: { key: string }) => c.key === k)?.value as string | undefined;
    const hook = get("discord_webhook_url"), role = get("discord_role_id");
    if (hook) {
      const ping = role ? `<@&${role}> ` : "";
      const content = action === "on"
        ? `${ping}**EMERGENCY MODE ON**: ${row?.title || ""}\nOrders, payments, messages and games are paused. ` +
          (lockdown && !lockdown.error ? `Data copied to secure storage (${lockdown.snapshot}); ${lockdown.signed_out} sessions signed out.` : `Lockdown failed: ${lockdown?.error || "unknown"}`)
        : `${ping}**Emergency mode off**. The site is open again.`;
      await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: role ? { roles: [role] } : { parse: [] } }) });
    }
  } catch (_) { /* ignore */ }

  return json({ active: !!row?.active, title: row?.title, started_at: row?.started_at, lockdown });
});
