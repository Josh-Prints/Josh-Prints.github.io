import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Emergency mode switch (Founder > Settings). Turning it on or off needs a signed-in founder AND the site master key.
// The key lives only in the SITE_MASTER_KEY function secret (Supabase dashboard > Edge Functions > Secrets), never in
// the database or the repo, so a database leak can't reveal it. Wrong keys are counted: 5 misses in 15 minutes from one
// founder (or 20 from anyone) locks the switch for 15 minutes. Every attempt is logged in site_emergency_attempts.
//   action "on":  { key, title, report, run }  pauses the site, copies everyone's data into the private secure_store
//                 schema (rpc emergency_snapshot) and signs everyone out except founders (rpc emergency_signout)
//   action "off": { key, run }
// Each step is written to site_emergency_log under `run` (a uuid from the page) so the founder page can show it live.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  let body: { action?: string; key?: string; title?: string; report?: string; run?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = body.action;
  if (action !== "on" && action !== "off") return json({ error: "Unknown action" }, 400);
  const run = UUID.test(String(body.run || "")) ? String(body.run) : crypto.randomUUID();

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = /^eyJ/.test(bearer) ? await admin.auth.getUser(bearer) : { data: null };
  const uid = who?.user?.id;
  if (!uid) return json({ error: "Sign in first" }, 401);
  const { data: prof } = await admin.from("admin_profiles").select("is_founder, suspended_until").eq("id", uid).maybeSingle();
  const suspended = !!prof?.suspended_until && new Date(prof.suspended_until as string).getTime() > Date.now();
  if (!prof?.is_founder || suspended) return json({ error: "Founders only" }, 403);

  const log = (step: string, ok = true, detail: string | null = null) =>
    admin.from("site_emergency_log").insert({ run_id: run, action, step, ok, detail, by_user: uid }).then(() => {}, () => {});

  const secret = Deno.env.get("SITE_MASTER_KEY") || "";
  if (secret.length < 8) { await log("Master key isn't set up", false); return json({ error: "Master key isn't set up", run }, 503); }

  // lockout after repeated wrong keys
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    admin.from("site_emergency_attempts").select("id", { count: "exact", head: true }).eq("ok", false).eq("user_id", uid).gte("at", since),
    admin.from("site_emergency_attempts").select("id", { count: "exact", head: true }).eq("ok", false).gte("at", since),
  ]);
  if ((mine || 0) >= 5 || (all || 0) >= 20) {
    await log("Locked: too many wrong keys", false);
    return json({ error: "Too many wrong keys. Try again in 15 minutes.", run }, 429);
  }

  const ok = await sameKey(String(body.key || ""), secret);
  await admin.from("site_emergency_attempts").insert({ user_id: uid, ok, action });
  if (!ok) { await log("Wrong master key", false); return json({ error: "Wrong master key", run }, 403); }
  await log("Master key accepted");

  const now = new Date().toISOString();
  let row, signedOut: number | null = null, snapshot: string | null = null, failed = false;
  if (action === "on") {
    const title = String(body.title || "").trim().slice(0, 80);
    const report = String(body.report || "").trim().slice(0, 4000);
    if (!title) return json({ error: "Add a title", run }, 400);
    const { data, error } = await admin.from("site_emergency").update({
      active: true, title, report, started_at: now, ended_at: null, changed_by: uid, updated_at: now,
    }).eq("id", 1).select().single();
    row = data;
    if (error || !row?.active) { await log("Couldn't turn emergency mode on", false, error?.message || null); return json({ error: "Couldn't turn it on", run }, 500); }
    await log("Emergency mode on", true, title);
    await log("Paused: new orders, payments, messages, email codes, games");

    // 1. secure copy of everyone's data
    await log("Copying data to secure storage…");
    const { data: snap, error: se } = await admin.rpc("emergency_snapshot", { p_reason: title });
    if (se) { failed = true; await log("Secure copy failed", false, se.message); }
    else {
      snapshot = snap?.snapshot || null;
      for (const [t, n] of Object.entries((snap?.tables || {}) as Record<string, number>)) await log("Copied " + t, true, n + " rows");
      await log("Secure copy saved", true, "secure_store, " + snapshot);
    }

    // 2. sign everyone out (founders keep their session so the switch can be turned off)
    await log("Signing everyone out…");
    const { data: n, error: oe } = await admin.rpc("emergency_signout");
    if (oe) { failed = true; await log("Sign-out failed", false, oe.message); }
    else { signedOut = Number(n) || 0; await log("Signed out " + signedOut + " sessions", true, "founders stay signed in"); }

    await log("Customer data hidden from everyone but founders");
  } else {
    const { data, error } = await admin.from("site_emergency").update({
      active: false, ended_at: now, changed_by: uid, updated_at: now,
    }).eq("id", 1).select().single();
    row = data;
    if (error || row?.active) { await log("Couldn't turn emergency mode off", false, error?.message || null); return json({ error: "Couldn't turn it off", run }, 500); }
    await log("Emergency mode off");
    await log("Reopened: orders, payments, messages, email codes, games");
    await log("Customer data visible again", true, "people sign in again as normal");
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
          (snapshot ? `Data copied to secure storage (${snapshot}). ` : "Secure copy FAILED. ") +
          (signedOut != null ? `${signedOut} sessions signed out.` : "Sign-out FAILED.")
        : `${ping}**Emergency mode off**. The site is open again.`;
      const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: role ? { roles: [role] } : { parse: [] } }) });
      await log(r.ok ? "Discord alerted" : "Discord alert failed", r.ok, r.ok ? null : "status " + r.status);
    }
  } catch (e) { await log("Discord alert failed", false, (e as Error).message); }

  await log(failed ? "Finished with problems" : "Done", !failed);
  return json({ active: !!row?.active, title: row?.title, started_at: row?.started_at, run, snapshot, signed_out: signedOut, failed });
});
