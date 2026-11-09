// wa-oficial — Atendimento do WhatsApp Oficial (Cloud API) dentro do Reino CRM.
//
// Uma função só, três entradas:
//  GET  ?hub.mode=subscribe&hub.verify_token=...  -> verificação do webhook da Meta
//  POST (Meta)                                     -> mensagens recebidas + status de entrega
//  POST {acao:"enviar", message_id} + x-reino-secret -> envia o que o time escreveu no CRM
//
// Grava em contacts / conversations / messages com channel = 'oficial'.
// Continua atualizando wa_disparos (entregue/lido/falha/respondeu), como o fluxo
// n8n "MR78 — WhatsApp Status/Respostas" fazia, para os funis de disparo não quebrarem.
//
// Segredos (Edge Function secrets, com fallback na tabela app_secrets):
//   WA_TOKEN            token permanente do usuário do sistema (Meta)
//   ANTHROPIC_API_KEY   chave da IA
//   WA_PHONE_NUMBER_ID  opcional (padrão: número da Reino)
//   META_APP_SECRET     opcional: se existir, valida a assinatura X-Hub-Signature-256

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const GRAPH = "https://graph.facebook.com/v21.0";
const STAGE_NOVO_LEAD = "3441a20e-d74c-4315-b112-c96189c962b9";
const DEFAULT_PHONE_ID = "1095430970325134";
const DEBOUNCE_MS = 7000; // espera o lead terminar de digitar antes da IA responder
const PAUSA_HUMANO_H = 12; // quando o time responde, a IA fica quieta nessa conversa por X horas

// ---------------------------------------------------------------- utilidades
const secretCache = new Map<string, string>();
async function secret(envName: string, tableKey: string): Promise<string> {
  const env = Deno.env.get(envName);
  if (env) return env;
  if (secretCache.has(tableKey)) return secretCache.get(tableKey)!;
  const { data } = await sb.from("app_secrets").select("value").eq("key", tableKey).maybeSingle();
  const v = (data?.value as string) || "";
  if (v) secretCache.set(tableKey, v);
  return v;
}
async function config(chave: string, padrao = ""): Promise<string> {
  const { data } = await sb.from("crm_config").select("valor").eq("chave", chave).maybeSingle();
  return (data?.valor as string) ?? padrao;
}
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function validaAssinatura(req: Request, raw: string): Promise<boolean> {
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) return true; // sem segredo configurado, não valida
  const sig = req.headers.get("x-hub-signature-256") || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === "sha256=" + hex;
}

// ---------------------------------------------------------------- Cloud API
async function waEnviarTexto(to: string, body: string) {
  const token = await secret("WA_TOKEN", "wa_oficial_token");
  const phoneId = Deno.env.get("WA_PHONE_NUMBER_ID") || (await secret("WA_PHONE_NUMBER_ID", "wa_oficial_phone_id")) || DEFAULT_PHONE_ID;
  if (!token) return { ok: false, erro: "Token do WhatsApp (WA_TOKEN) não configurado" };
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.messages?.[0]?.id) {
    const e = j?.error;
    return { ok: false, erro: e ? `${e.code ?? ""} ${e.message ?? ""}`.trim() : `HTTP ${r.status}` };
  }
  return { ok: true, wamid: j.messages[0].id as string };
}

async function waMarcarLida(wamid: string) {
  try {
    const token = await secret("WA_TOKEN", "wa_oficial_token");
    const phoneId = Deno.env.get("WA_PHONE_NUMBER_ID") || DEFAULT_PHONE_ID;
    if (!token) return;
    await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: wamid }),
    });
  } catch (_) { /* não importa */ }
}

// ---------------------------------------------------------------- recebimento
function textoDaMensagem(m: any): { text: string; tipo: string | null } {
  switch (m.type) {
    case "text": return { text: m.text?.body ?? "", tipo: null };
    case "button": return { text: m.button?.text ?? "", tipo: null };
    case "interactive": return { text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "", tipo: null };
    case "image": return { text: "[📷 imagem]" + (m.image?.caption ? " " + m.image.caption : ""), tipo: "image" };
    case "video": return { text: "[🎬 vídeo]" + (m.video?.caption ? " " + m.video.caption : ""), tipo: "video" };
    case "audio": return { text: "[🎤 áudio]", tipo: "audio" };
    case "document": return { text: "[📎 documento] " + (m.document?.filename ?? ""), tipo: "file" };
    case "sticker": return { text: "[figurinha]", tipo: "image" };
    case "location": return { text: `[📍 localização] ${m.location?.name ?? ""} ${m.location?.latitude ?? ""},${m.location?.longitude ?? ""}`, tipo: null };
    case "contacts": return { text: "[👤 contato compartilhado]", tipo: null };
    case "reaction": return { text: `[reagiu ${m.reaction?.emoji ?? ""}]`, tipo: null };
    default: return { text: `[${m.type ?? "mensagem"}]`, tipo: null };
  }
}

async function garantirConversa(fone: string, nome: string | null) {
  // contato do canal oficial (1 por telefone)
  let { data: ct } = await sb.from("contacts").select("id, full_name").eq("channel", "oficial").eq("phone", fone).maybeSingle();
  if (!ct) {
    const ins = await sb.from("contacts").insert({ channel: "oficial", phone: fone, full_name: nome, ig_user_id: "wa:" + fone }).select("id, full_name").single();
    if (ins.error) {
      const again = await sb.from("contacts").select("id, full_name").eq("channel", "oficial").eq("phone", fone).maybeSingle();
      ct = again.data;
    } else ct = ins.data;
  } else if (!ct.full_name && nome) {
    await sb.from("contacts").update({ full_name: nome }).eq("id", ct.id);
  }
  if (!ct) throw new Error("não consegui criar o contato " + fone);

  let { data: conv } = await sb.from("conversations").select("id, ia_ativa, ia_pausada_ate, is_archived").eq("channel", "oficial").eq("contact_id", ct.id).maybeSingle();
  if (!conv) {
    const ins = await sb.from("conversations").insert({ channel: "oficial", contact_id: ct.id, stage_id: STAGE_NOVO_LEAD, ia_ativa: true, origem: null }).select("id, ia_ativa, ia_pausada_ate, is_archived").single();
    if (ins.error) {
      const again = await sb.from("conversations").select("id, ia_ativa, ia_pausada_ate, is_archived").eq("channel", "oficial").eq("contact_id", ct.id).maybeSingle();
      conv = again.data;
    } else conv = ins.data;
  } else if (conv.is_archived) {
    await sb.from("conversations").update({ is_archived: false }).eq("id", conv.id);
  }
  if (!conv) throw new Error("não consegui criar a conversa " + fone);
  return { contactId: ct.id as string, conv };
}

async function processarStatus(s: any) {
  const mid = s?.id;
  if (!mid) return;
  const now = new Date().toISOString();
  let patch: Record<string, unknown> | null = null;
  if (s.status === "delivered") patch = { entregue: true, entregue_em: now };
  else if (s.status === "read") patch = { entregue: true, lido: true, lido_em: now };
  else if (s.status === "failed") patch = { falha: true, erro: s.errors ? JSON.stringify(s.errors) : "failed" };
  if (patch) await sb.from("wa_disparos").update(patch).eq("message_id", mid);

  // mensagem enviada pelo CRM que falhou depois de aceita
  if (s.status === "failed") {
    const erro = s.errors?.[0]?.title || s.errors?.[0]?.message || "falhou na entrega";
    const { data: msg } = await sb.from("messages").select("id, raw").eq("ig_message_id", mid).maybeSingle();
    if (msg) await sb.from("messages").update({ raw: { ...(msg.raw || {}), erro } }).eq("id", msg.id);
  }
}

async function processarMensagem(m: any, contatos: any[]) {
  const fone = digits(m.from);
  if (!fone || !m.id) return null;
  const nome = contatos.find((c) => digits(c.wa_id) === fone)?.profile?.name ?? null;
  const { text, tipo } = textoDaMensagem(m);
  const now = new Date().toISOString();

  // funil dos disparos (igual ao fluxo n8n antigo)
  await sb.from("wa_disparos").update({ respondeu: true, respondeu_em: now, resposta: text || m.type }).eq("phone", fone).eq("respondeu", false);

  const { contactId, conv } = await garantirConversa(fone, nome);
  const ins = await sb.from("messages").insert({
    conversation_id: conv.id, direction: "inbound", ig_message_id: m.id, sender_id: fone,
    text, attachment_type: tipo, raw: m,
  }).select("id").single();
  if (ins.error) return null; // wamid repetido = a Meta reenviou; ignora
  waMarcarLida(m.id);
  return { convId: conv.id as string, contactId, msgId: ins.data.id as string, fone, nome };
}

// ---------------------------------------------------------------- IA
const FORMATO = `

FORMATO DA SUA RESPOSTA
Sempre use a ferramenta "responder". Em "resposta" vai o texto que será enviado ao cliente no WhatsApp.
Marque "transferir_humano" = true quando precisar de alguém do time, e explique em "motivo".`;

async function rodarIA(convId: string, msgId: string, fone: string, nome: string | null) {
  if ((await config("oficial_ia_ativa", "true")) !== "true") return;

  // espera o lead parar de digitar; só a última mensagem dispara a IA
  await sleep(DEBOUNCE_MS);
  const { data: ultima } = await sb.from("messages").select("id").eq("conversation_id", convId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (ultima?.id !== msgId) return;

  const { data: conv } = await sb.from("conversations").select("ia_ativa, ia_pausada_ate").eq("id", convId).single();
  if (!conv || conv.ia_ativa === false) return;
  if (conv.ia_pausada_ate && new Date(conv.ia_pausada_ate) > new Date()) return;

  const apiKey = await secret("ANTHROPIC_API_KEY", "anthropic_api_key");
  if (!apiKey) { console.error("ANTHROPIC_API_KEY não configurada"); return; }

  const { data: hist } = await sb.from("messages").select("direction, text, created_at").eq("conversation_id", convId)
    .order("created_at", { ascending: false }).limit(40);
  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  for (const h of (hist || []).reverse()) {
    const role = h.direction === "inbound" ? "user" : "assistant";
    const t = (h.text || "").trim();
    if (!t) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += "\n" + t;
    else msgs.push({ role, content: t });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length) return;

  const prompt = (await config("oficial_ia_prompt")) + FORMATO +
    `\n\nDADOS DO CLIENTE\nNome no WhatsApp: ${nome || "(sem nome)"}\nTelefone: ${fone}\nAgora: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
  const modelo = await config("oficial_ia_modelo", "claude-sonnet-5");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: modelo, max_tokens: 1024,
      system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }],
      messages: msgs,
      tools: [{
        name: "responder",
        description: "Responde o cliente no WhatsApp e indica se precisa passar para humano.",
        input_schema: {
          type: "object",
          properties: {
            resposta: { type: "string", description: "Texto para enviar ao cliente" },
            transferir_humano: { type: "boolean" },
            motivo: { type: "string", description: "Por que transferiu (vazio se não transferiu)" },
          },
          required: ["resposta", "transferir_humano"],
        },
      }],
      tool_choice: { type: "tool", name: "responder" },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("Anthropic erro", r.status, JSON.stringify(j).slice(0, 500)); return; }
  const out = (j.content || []).find((c: any) => c.type === "tool_use")?.input;
  if (!out?.resposta) return;

  // o time pode ter assumido enquanto a IA pensava
  const { data: c2 } = await sb.from("conversations").select("ia_ativa, ia_pausada_ate").eq("id", convId).single();
  if (c2?.ia_ativa === false || (c2?.ia_pausada_ate && new Date(c2.ia_pausada_ate) > new Date())) return;

  const env = await waEnviarTexto(fone, out.resposta);
  await sb.from("messages").insert({
    conversation_id: convId, direction: "outbound", text: out.resposta, sender_id: "ia",
    ig_message_id: env.ok ? env.wamid : null,
    raw: env.ok ? { por: "ia" } : { por: "ia", erro: env.erro },
  });

  if (out.transferir_humano) {
    await sb.from("conversations").update({
      ia_ativa: false,
      next_action: "🤖 IA passou pro time: " + (out.motivo || "precisa de humano"),
      next_action_at: new Date().toISOString().slice(0, 10),
    }).eq("id", convId);
  }
}

// ---------------------------------------------------------------- envio pelo time
async function enviarDoCrm(messageId: string) {
  const { data: msg } = await sb.from("messages").select("id, conversation_id, text, ig_message_id, raw").eq("id", messageId).maybeSingle();
  if (!msg || msg.ig_message_id) return { ok: true, pulado: true };
  const { data: conv } = await sb.from("conversations").select("id, channel, last_inbound_at, contacts(phone)").eq("id", msg.conversation_id).single();
  if (!conv || conv.channel !== "oficial") return { ok: false, erro: "conversa não é do canal oficial" };
  const fone = digits((conv as any).contacts?.phone);

  const marcaErro = (erro: string) => sb.from("messages").update({ raw: { ...(msg.raw || {}), erro } }).eq("id", msg.id);
  if (!fone) { await marcaErro("contato sem telefone"); return { ok: false }; }
  const janela = conv.last_inbound_at && Date.now() - new Date(conv.last_inbound_at).getTime() < 24 * 3600 * 1000;
  if (!janela) {
    await marcaErro("Fora da janela de 24h: o cliente precisa mandar mensagem primeiro (ou use um template aprovado).");
    return { ok: false };
  }
  const env = await waEnviarTexto(fone, msg.text || "");
  if (!env.ok) { await marcaErro(env.erro!); return { ok: false }; }
  await sb.from("messages").update({ ig_message_id: env.wamid, raw: { ...(msg.raw || {}), por: "time" } }).eq("id", msg.id);
  // time respondeu: IA fica quieta por um tempo nessa conversa
  await sb.from("conversations").update({ ia_pausada_ate: new Date(Date.now() + PAUSA_HUMANO_H * 3600 * 1000).toISOString() }).eq("id", conv.id);
  return { ok: true };
}

// ---------------------------------------------------------------- servidor
Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    const esperado = await secret("WA_VERIFY_TOKEN", "wa_oficial_verify_token");
    if (mode === "subscribe" && token && token === esperado) return new Response(challenge, { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  let body: any = {};
  try { body = JSON.parse(raw); } catch (_) { return json({ ok: false, erro: "json inválido" }, 400); }

  // chamada interna (gatilho do banco quando o time escreve no CRM)
  if (body?.acao === "enviar") {
    const interno = await secret("WA_INTERNAL_SECRET", "wa_oficial_internal");
    if (!interno || req.headers.get("x-reino-secret") !== interno) return json({ ok: false }, 401);
    return json(await enviarDoCrm(String(body.message_id)));
  }

  // webhook da Meta
  if (!(await validaAssinatura(req, raw))) return json({ ok: false, erro: "assinatura inválida" }, 401);

  const trabalho = (async () => {
    for (const e of body.entry || []) {
      for (const ch of e.changes || []) {
        const v = ch.value || {};
        for (const s of v.statuses || []) { try { await processarStatus(s); } catch (err) { console.error("status", err); } }
        for (const m of v.messages || []) {
          try {
            const r = await processarMensagem(m, v.contacts || []);
            if (r) await rodarIA(r.convId, r.msgId, r.fone, r.nome);
          } catch (err) { console.error("mensagem", err); }
        }
      }
    }
  })();
  // responde 200 na hora pra Meta não reenviar; o resto roda em segundo plano
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(trabalho); else await trabalho;
  return json({ ok: true });
});
