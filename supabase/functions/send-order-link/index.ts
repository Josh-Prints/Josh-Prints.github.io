// Retired. This used to email any address any HTML through the shop's Resend account (an open relay for phishing).
// Order emails are sent by the database (notify_order_confirmation), so this now refuses every request.
Deno.serve(() => new Response(JSON.stringify({ error: "Gone" }), { status: 410, headers: { "Content-Type": "application/json" } }));
