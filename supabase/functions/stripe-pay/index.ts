import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Card payments for quoted orders, through Stripe Checkout (Stripe's own payment page; card details never touch
// the site). Two actions:
//   checkout: make a Checkout Session for the order's quoted amount and return its URL
//   confirm:  ask Stripe whether the order's session was paid, and if so mark the order paid
// The order is only ever marked paid from what Stripe itself reports, never from what the browser says.
// The secret key is the STRIPE_SECRET_KEY function secret (or private_config.stripe_secret_key).
// EXPERIMENTAL: only a signed-in founder can use it for now.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://voxprints.com";
const PAYABLE = ["quoted", "printing", "completed"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function stripeKey(admin: ReturnType<typeof createClient>) {
  const env = Deno.env.get("STRIPE_SECRET_KEY");
  if (env) return env;
  const { data } = await admin.from("private_config").select("value").eq("key", "stripe_secret_key").maybeSingle();
  return (data?.value as string) || "";
}

async function stripe(key: string, method: string, path: string, form?: Record<string, string>) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || "Stripe error " + res.status);
  return body;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(bearer)) return json({ error: "Not allowed" }, 401);

  let body: { action?: string; orderId?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const orderId = String(body.orderId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return json({ error: "Bad order id" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: who } = await admin.auth.getUser(bearer);
  if (!who?.user) return json({ error: "Not allowed" }, 401);
  const { data: prof } = await admin.from("admin_profiles").select("is_founder").eq("id", who.user.id).maybeSingle();
  if (!prof?.is_founder) return json({ error: "Not allowed" }, 403);
  const { data: order } = await admin.from("orders")
    .select("id, full_name, email, status, quote_amount, deleted, design_name, order_type, paid_at, stripe_session_id")
    .eq("id", orderId).maybeSingle();
  if (!order || order.deleted) return json({ error: "Order not found" }, 404);
  const key = await stripeKey(admin);
  if (!key) return json({ error: "Card payments aren't set up yet" }, 503);

  try {
    if (body.action === "confirm") {
      if (order.paid_at) return json({ paid: true });
      if (!order.stripe_session_id) return json({ paid: false });
      const s = await stripe(key, "GET", "/checkout/sessions/" + encodeURIComponent(order.stripe_session_id));
      if (s.payment_status !== "paid" || s.client_reference_id !== order.id) return json({ paid: false });
      await admin.from("orders").update({
        paid_at: new Date().toISOString(), paid_amount: s.amount_total / 100, paid_method: "card",
        stripe_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null,
      }).eq("id", order.id).is("paid_at", null);
      return json({ paid: true });
    }

    if (body.action === "checkout") {
      if (order.paid_at) return json({ error: "This order is already paid" }, 409);
      const amount = Math.round(Number(order.quote_amount) * 100);
      if (!PAYABLE.includes(order.status) || !(amount >= 50)) return json({ error: "This order can't be paid online yet" }, 409);
      const back = `${SITE}/order.html?order=${order.id}`;
      const name = "Voxprints order" + (order.design_name ? ": " + order.design_name : "");
      const s = await stripe(key, "POST", "/checkout/sessions", {
        mode: "payment",
        client_reference_id: order.id,
        "metadata[order_id]": order.id,
        "payment_intent_data[metadata][order_id]": order.id,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "aud",
        "line_items[0][price_data][unit_amount]": String(amount),
        "line_items[0][price_data][product_data][name]": name.slice(0, 200),
        ...(order.email ? { customer_email: String(order.email) } : {}),
        "invoice_creation[enabled]": "true",
        success_url: back + "&paid=1",
        cancel_url: back,
      });
      await admin.from("orders").update({ stripe_session_id: s.id }).eq("id", order.id);
      return json({ url: s.url });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
