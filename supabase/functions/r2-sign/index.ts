import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Hands out short-lived, single-file upload addresses for the Cloudflare R2 bucket (files over 50 MB, which
// Supabase storage refuses). The R2 keys live in private_config and are only ever read here, server-side.
// Public on purpose: guests place orders too. Guests only hold the site's publishable key (not a login token), so
// the gateway JWT check is off and this function checks the key itself.
// Rate limits (r2_sign_log): 40 addresses / 30 GB an hour site-wide and 50 files per order, so nobody can use the
// bucket as free file hosting or run up the bill. Refused while emergency mode is on.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_KEY = "sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv";
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB (R2 takes up to ~5GB in one upload)
const MIN_BYTES = 1;
const EXPIRES = 900; // seconds the upload address stays valid
const HOUR_COUNT = 40, HOUR_BYTES = 30 * 1024 * 1024 * 1024, PER_ORDER = 50;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hmac(key: ArrayBuffer | Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function safeName(n: string) {
  const base = (n || "file").split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return base || "file";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apikey = req.headers.get("apikey") || "";
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (apikey !== SITE_KEY && bearer !== SITE_KEY && !/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(bearer)) return json({ error: "Not allowed" }, 401);

  let body: { orderId?: string; filename?: string; size?: number; contentType?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const orderId = String(body.orderId || "");
  const size = Number(body.size);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return json({ error: "Bad order id" }, 400);
  if (!Number.isInteger(size) || size < MIN_BYTES) return json({ error: "Bad file size" }, 400);
  if (size > MAX_BYTES) return json({ error: "That file is over the 2GB limit." }, 413);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: em } = await admin.from("site_emergency").select("active").eq("id", 1).maybeSingle();
  if (em?.active) return json({ error: "Uploads are paused" }, 503);

  // rate limits
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const [{ data: recent }, { count: forOrder }] = await Promise.all([
    admin.from("r2_sign_log").select("bytes").gte("at", since),
    admin.from("r2_sign_log").select("id", { count: "exact", head: true }).eq("order_id", orderId),
  ]);
  const used = (recent || []).reduce((s: number, r: { bytes: number }) => s + Number(r.bytes || 0), 0);
  if ((recent || []).length >= HOUR_COUNT || used + size > HOUR_BYTES) return json({ error: "Too many big uploads right now. Try again in an hour." }, 429);
  if ((forOrder || 0) >= PER_ORDER) return json({ error: "Too many files for one order." }, 429);

  const { data: rows, error } = await admin.from("private_config").select("key,value").in("key", ["r2_account_id", "r2_bucket", "r2_public_url", "r2_access_key_id", "r2_secret_access_key"]);
  if (error || !rows) return json({ error: "Storage is not configured" }, 500);
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  if (!cfg.r2_account_id || !cfg.r2_bucket || !cfg.r2_access_key_id || !cfg.r2_secret_access_key || !cfg.r2_public_url) return json({ error: "Storage is not configured" }, 500);

  await admin.from("r2_sign_log").insert({ order_id: orderId, bytes: size });

  const rand = hex(crypto.getRandomValues(new Uint8Array(6)).buffer);
  const key = `orders/${orderId}/${rand}-${safeName(String(body.filename || "file"))}`;

  const host = `${cfg.r2_account_id}.r2.cloudflarestorage.com`;
  const region = "auto", service = "s3";
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
  const day = amz.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const path = `/${cfg.r2_bucket}/${key.split("/").map(rfc3986).join("/")}`;
  const signedHeaders = "content-length;host";

  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.r2_access_key_id}/${scope}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(EXPIRES),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`).join("&");
  // content-length is signed, so the upload can't be larger than the size that was declared above
  const canonicalRequest = ["PUT", path, canonicalQuery, `content-length:${size}\nhost:${host}\n`, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, await sha256Hex(canonicalRequest)].join("\n");
  let k: ArrayBuffer | Uint8Array = enc.encode("AWS4" + cfg.r2_secret_access_key);
  for (const part of [day, region, service, "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, stringToSign));

  return json({
    uploadUrl: `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    publicUrl: `${cfg.r2_public_url.replace(/\/+$/, "")}/${key.split("/").map(rfc3986).join("/")}`,
    key,
    expiresIn: EXPIRES,
  });
});
