import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Card payments for quoted orders. Card details go straight from the browser to Stripe (Stripe's Payment Element
// or hosted Checkout); they never touch our servers. Actions:
//   intent:   make (or reuse) a PaymentIntent for the order's quoted amount, for the custom payment form on the
//             order page; returns its client secret and the matching publishable key
//   checkout: make a hosted Checkout Session instead and return its URL (the older flow)
//   confirm:  ask Stripe whether the order's payment went through, and if so mark the order paid
//   refund:   refund a card-paid order through Stripe (all of it, or `amount` dollars)
// The order is only ever marked paid from what Stripe itself reports, never from what the browser says.
// The secret key is the STRIPE_SECRET_KEY function secret (or private_config.stripe_secret_key).
// EXPERIMENTAL: only signed-in admins can pay for now; only founders can refund.

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

// the publishable key that goes with the secret key's mode (publishable keys are public; stored in private_config)
async function publishableKey(admin: ReturnType<typeof createClient>, secret: string) {
  const name = secret.startsWith("sk_live_") || secret.startsWith("rk_live_") ? "stripe_publishable_key_live" : "stripe_publishable_key_test";
  const { data } = await admin.from("private_config").select("value").eq("key", name).maybeSingle();
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

  let body: { action?: string; orderId?: string; amount?: number };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const orderId = String(body.orderId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return json({ error: "Bad order id" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: who } = await admin.auth.getUser(bearer);
  if (!who?.user) return json({ error: "Not allowed" }, 401);
  // paying: any admin who isn't suspended; refunds: founders only
  const { data: prof } = await admin.from("admin_profiles").select("is_founder, suspended_until").eq("id", who.user.id).maybeSingle();
  const suspended = !!prof?.suspended_until && new Date(prof.suspended_until as string).getTime() > Date.now();
  if (!prof || suspended) return json({ error: "Not allowed" }, 403);
  if (body.action === "refund" && !prof.is_founder) return json({ error: "Not allowed" }, 403);
  const { data: order } = await admin.from("orders")
    .select("id, full_name, email, status, quote_amount, deleted, design_name, order_type, paid_at, paid_amount, paid_method, stripe_session_id, stripe_payment_intent, refunded_at")
    .eq("id", orderId).maybeSingle();
  if (!order || (order.deleted && body.action !== "refund")) return json({ error: "Order not found" }, 404);
  const key = await stripeKey(admin);
  if (!key) return json({ error: "Card payments aren't set up yet" }, 503);

  try {
    if (body.action === "confirm") {
      if (order.paid_at) return json({ paid: true });
      const markPaid = (cents: number, pi: string | null) => admin.from("orders").update({
        paid_at: new Date().toISOString(), paid_amount: cents / 100, paid_method: "card", stripe_payment_intent: pi,
      }).eq("id", order.id).is("paid_at", null);
      // the custom form: the PaymentIntent itself
      if (order.stripe_payment_intent) {
        const pi = await stripe(key, "GET", "/payment_intents/" + encodeURIComponent(order.stripe_payment_intent)).catch(() => null);
        if (pi?.status === "succeeded" && pi.metadata?.order_id === order.id) { await markPaid(pi.amount_received, pi.id); return json({ paid: true }); }
        if (pi?.status === "processing") return json({ paid: false, processing: true });
      }
      // the hosted checkout
      if (order.stripe_session_id) {
        const s = await stripe(key, "GET", "/checkout/sessions/" + encodeURIComponent(order.stripe_session_id)).catch(() => null);
        if (s?.payment_status === "paid" && s.client_reference_id === order.id) {
          await markPaid(s.amount_total, typeof s.payment_intent === "string" ? s.payment_intent : null);
          return json({ paid: true });
        }
      }
      return json({ paid: false });
    }

    if (body.action === "intent") {
      if (order.paid_at) return json({ error: "This order is already paid" }, 409);
      const amount = Math.round(Number(order.quote_amount) * 100);
      if (!PAYABLE.includes(order.status) || !(amount >= 50)) return json({ error: "This order can't be paid online yet" }, 409);
      const pk = await publishableKey(admin, key);
      if (!pk) return json({ error: "Card payments aren't set up yet" }, 503);
      // reuse the order's unpaid PaymentIntent (updating the amount if the quote changed), else make a new one
      if (order.stripe_payment_intent) {
        try {
          let pi = await stripe(key, "GET", "/payment_intents/" + encodeURIComponent(order.stripe_payment_intent));
          if (pi.metadata?.order_id === order.id && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
            if (pi.amount !== amount) pi = await stripe(key, "POST", "/payment_intents/" + pi.id, { amount: String(amount) });
            return json({ clientSecret: pi.client_secret, publishableKey: pk, amount });
          }
        } catch (_) { /* made with another key (test vs live): start a new one */ }
      }
      const name = "Voxprints order" + (order.design_name ? ": " + order.design_name : "");
      const pi = await stripe(key, "POST", "/payment_intents", {
        amount: String(amount),
        currency: "aud",
        "automatic_payment_methods[enabled]": "true",
        description: name.slice(0, 200),
        "metadata[order_id]": order.id,
        ...(order.email ? { receipt_email: String(order.email) } : {}),
      });
      await admin.from("orders").update({ stripe_payment_intent: pi.id }).eq("id", order.id);
      return json({ clientSecret: pi.client_secret, publishableKey: pk, amount });
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
    if (body.action === "refund") {
      if (!order.paid_at || order.paid_method !== "card" || !order.stripe_payment_intent) return json({ error: "Only card payments can be refunded here" }, 409);
      if (order.refunded_at) return json({ error: "Already refunded" }, 409);
      const paidCents = Math.round(Number(order.paid_amount) * 100);
      const cents = body.amount == null ? paidCents : Math.round(Number(body.amount) * 100);
      if (!(cents >= 1 && cents <= paidCents)) return json({ error: "Pick an amount up to " + (paidCents / 100).toFixed(2) }, 400);
      const r = await stripe(key, "POST", "/refunds", {
        payment_intent: order.stripe_payment_intent, amount: String(cents), "metadata[order_id]": order.id,
      });
      if (r.status === "failed" || r.status === "canceled") return json({ error: "Stripe couldn't refund this payment" }, 502);
      await admin.from("orders").update({ refunded_at: new Date().toISOString(), refunded_amount: cents / 100 }).eq("id", order.id);
      return json({ refunded: cents / 100, status: r.status });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
