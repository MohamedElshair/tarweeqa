// Tarweeqa — sends the e-mails waiting in tq_mail (queued by database triggers).
// Woken every minute by pg_cron (tq_mail_kick) when something is waiting. Safe to call by anyone:
// it only ever sends what the database already queued, once.
// Secrets: RESEND_API_KEY (required), MAIL_FROM (optional, default "ترويقة <noreply@tarweaqa.com>").
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("MAIL_FROM") || "ترويقة <noreply@tarweaqa.com>";

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

Deno.serve(async () => {
  if (!KEY) return Response.json({ ok: false, reason: "RESEND_API_KEY not set" });
  const batch: { id: number; email: string; subject: string; html: string }[] = await rpc("tq_mail_claim", { p_limit: 20 });
  let sent = 0;
  for (const m of batch || []) {
    let err: string | null = null;
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [m.email], subject: m.subject, html: m.html }),
      });
      if (!r.ok) err = `${r.status} ${(await r.text()).slice(0, 300)}`;
    } catch (e) {
      err = String(e).slice(0, 300);
    }
    await rpc("tq_mail_done", { p_id: m.id, p_error: err });
    if (!err) sent++;
  }
  return Response.json({ ok: true, sent, of: (batch || []).length });
});
