// lead-site — caminho pelo nosso servidor para o cadastro dos funis do site (16/11/2026).
//
// POST (público, chamado pela página) {funil, nome, email, whatsapp, countryCode, instagram, segmento, perfil,
//   receita, pagina, utm, event_id?, fbp?, fbc?, pixel_id?}
//
//  1. grava em site_leads (1 linha por funil + WhatsApp)
//  2. repassa pro n8n "Captação → CRM" (card no CRM; idempotente, roda sempre)
//  3. só na 1ª vez do lead nesse funil: repassa "aplicou" pro n8n do funil (aviso LEAD NOVO + toque se não agendar)
//  4. se vier event_id: manda "Lead" pela API de Conversões (CAPI) com o MESMO event_id do Pixel do navegador
//     (a Meta junta os dois e conta 1)
//
// A página continua mandando direto pro n8n também: se um dos caminhos cair, o outro entrega.
// Token CAPI: env CAPI_TOKEN || app_secrets.capi_token || env WA_TOKEN (system user, testado 16/11).

import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const N8N = "https://scarycrocodile-n8n.cloudfy.live/webhook";
const FUNIS: Record<string, { pixel: string; aplicou: string; qualifica: (receita: string) => boolean }> = {
  "diagnostico-agenda-lotada-bf": {
    pixel: "1275620937717354", // Pixel Mentores V3
    aplicou: N8N + "/funil-diagnostico",
    qualifica: (r) => !["ate-5k", "5k-10k"].includes(r), // 10k+
  },
};
const NAO_REGISTRAR = ["5511988887777"]; // número de teste antigo

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const s = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function sha256(v: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function tokens() {
  const out: { fonte: string; token: string }[] = [];
  const env = (n: string) => { const v = Deno.env.get(n); if (v) out.push({ fonte: "env:" + n, token: v }); };
  env("CAPI_TOKEN");
  const { data } = await sb.from("app_secrets").select("value").eq("key", "capi_token").maybeSingle();
  if (data?.value) out.push({ fonte: "app_secrets:capi_token", token: String(data.value) });
  env("WA_TOKEN");
  return out;
}
let tokenBom: { fonte: string; token: string } | null = null;
async function capi(pixel: string, evento: Record<string, unknown>) {
  const tentativas: { fonte: string; erro: string }[] = [];
  for (const t of tokenBom ? [tokenBom] : await tokens()) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pixel}/events`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [evento], access_token: t.token }), signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j?.events_received) { tokenBom = t; return { ok: true, fonte: t.fonte }; }
    tentativas.push({ fonte: t.fonte, erro: String(j?.error?.message ?? `HTTP ${r.status}`).slice(0, 200) });
  }
  return { ok: false, tentativas };
}

async function post(url: string, body: BodyInit, tipo: string) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": tipo }, body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${url} respondeu ${r.status}`);
  return r.status;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);
  let d: Record<string, unknown>;
  try {
    const bruto = await req.text();
    if (!bruto || bruto.length > 8000) return json({ ok: false }, 400);
    d = JSON.parse(bruto);
  } catch { return json({ ok: false }, 400); }

  const funil = s(d.funil, 60);
  const F = FUNIS[funil];
  if (!F) return json({ ok: false, erro: "funil desconhecido" }, 400);
  const receita = s(d.receita, 40);
  if (!F.qualifica(receita)) return json({ ok: true, ignorado: "fora do perfil" });

  const ddi = (s(d.countryCode, 6) || "+55").replace(/\D/g, "") || "55";
  let fone = s(d.whatsapp, 30).replace(/\D/g, "");
  if (fone && fone.length <= 11) fone = ddi + fone;
  const email = s(d.email, 160).toLowerCase();
  const nome = s(d.nome, 120);
  if (!fone || fone.length < 12 || fone.length > 15) return json({ ok: false, erro: "whatsapp" }, 422);
  if (NAO_REGISTRAR.includes(fone)) return json({ ok: true, ignorado: "teste" });

  const utm = (d.utm && typeof d.utm === "object" ? d.utm : {}) as Record<string, string>;
  const lead = {
    nome, email, whatsapp: fone, countryCode: "+" + ddi,
    instagram: s(d.instagram, 60), segmento: s(d.segmento, 60), perfil: s(d.perfil, 60), receita,
  };
  const pagina = s(d.pagina, 300);
  const eventId = s(d.event_id, 80);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
  const ua = req.headers.get("user-agent");

  // 1ª vez do lead nesse funil?
  const ins = await sb.from("site_leads").insert({ funil, whatsapp: fone, email: email || null, nome: nome || null, dados: { ...lead, pagina, utm } })
    .select("id").maybeSingle();
  const primeira = !ins.error && !!ins.data;
  const leadId = ins.data?.id ?? null;
  if (ins.error && ins.error.code !== "23505") console.error("site_leads", ins.error.message);

  const trabalho = (async () => {
    const log: Record<string, unknown> = { em: new Date().toISOString() };
    // 2. CRM (sempre — o n8n não duplica)
    const form = new URLSearchParams({
      evento: funil, nome, email, whatsapp: "+" + fone, instagram: lead.instagram,
      segmento: lead.segmento, perfil: lead.perfil, receita, pagina, enviado_em: new Date().toISOString(), via: "servidor",
    });
    for (const [k, v] of Object.entries(utm)) if (v) form.append(k, String(v).slice(0, 200));
    try { log.crm = await post(N8N + "/captacao-crm", form, "application/x-www-form-urlencoded"); } catch (e) { log.crm = String(e).slice(0, 200); }
    // 3. aviso + toque (só 1ª vez)
    if (primeira) {
      try {
        log.aplicou = await post(F.aplicou, JSON.stringify({ estado: "aplicou", funil, qualificado: true, via: "servidor", answers: lead, utm }), "application/json");
      } catch (e) { log.aplicou = String(e).slice(0, 200); }
    }
    // 4. CAPI Lead (mesmo event_id do navegador)
    if (eventId) {
      const partes = nome.toLowerCase().split(/\s+/).filter(Boolean);
      const ud: Record<string, unknown> = {
        ph: [await sha256(fone)], external_id: [await sha256(fone)], country: [await sha256("br")],
      };
      if (email) ud.em = [await sha256(email)];
      if (partes[0]) ud.fn = [await sha256(partes[0])];
      if (partes.length > 1) ud.ln = [await sha256(partes[partes.length - 1])];
      if (ip) ud.client_ip_address = ip;
      if (ua) ud.client_user_agent = ua;
      const fbp = s(d.fbp, 120), fbc = s(d.fbc, 300);
      if (fbp) ud.fbp = fbp;
      if (fbc) ud.fbc = fbc;
      log.capi = await capi(F.pixel, {
        event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: eventId,
        action_source: "website", event_source_url: pagina || undefined, user_data: ud,
        custom_data: { content_name: "aplicacao_diagnostico", funil },
      }).catch((e) => ({ ok: false, erro: String(e).slice(0, 200) }));
    }
    if (leadId) await sb.from("site_leads").update({ envio: log }).eq("id", leadId);
    else await sb.from("site_leads").update({ ultimo_reenvio: log }).eq("funil", funil).eq("whatsapp", fone);
  })();
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(trabalho); else await trabalho;
  return json({ ok: true, primeira });
});
