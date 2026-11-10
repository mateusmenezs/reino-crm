// wa-jp — WhatsApp do JP (Evolution API, número não oficial) dentro da tela de Atendimento do Reino CRM.
//
//  POST (Evolution, evento messages.upsert)          -> grava conversa/mensagem com channel = 'jp'
//  POST {acao:"enviar", message_id} + x-reino-secret -> envia pela Evolution o que o time escreveu no CRM
//
// Sem IA por enquanto (decisão de 10/11/2026: só o time responde nesse número).
// Ignora grupos, status e newsletters. Mensagens que o próprio celular manda (fromMe) entram como saída.
// A conversa 'jp' usa o contato geral da pessoa (achado pelo telefone), como o fluxo antigo do Hermes fazia.
//
// Segredos (Edge Function secrets, com fallback na tabela app_secrets):
//   EVO_JP_APIKEY     chave da instância JP na Evolution        (app_secrets.evo_jp_apikey)
//   EVO_URL           opcional, padrão https://scarycrocodile-evolution.cloudfy.live
//   EVO_JP_INSTANCE   opcional, padrão JP
//   wa_jp_webhook_key (app_secrets) -> vai na URL do webhook (?k=...) para só a Evolution conseguir postar
//   wa_oficial_internal (app_secrets) -> mesmo segredo do gatilho banco -> função usado no Oficial

import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CANAL = "jp";
const STAGE_NOVO_LEAD = "3441a20e-d74c-4315-b112-c96189c962b9";
const EVO_URL = (Deno.env.get("EVO_URL") || "https://scarycrocodile-evolution.cloudfy.live").replace(/\/$/, "");
const INSTANCIA = Deno.env.get("EVO_JP_INSTANCE") || "JP";

const secretCache = new Map<string, string>();
async function secret(envName: string, tableKey: string): Promise<string> {
  const env = envName ? Deno.env.get(envName) : undefined;
  if (env) return env;
  if (secretCache.has(tableKey)) return secretCache.get(tableKey)!;
  const { data } = await sb.from("app_secrets").select("value").eq("key", tableKey).maybeSingle();
  const v = (data?.value as string) || "";
  if (v) secretCache.set(tableKey, v);
  return v;
}
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// celular BR com e sem o 9 (o WhatsApp às vezes devolve sem)
function variantes(fone: string): string[] {
  const v = [fone];
  if (fone.startsWith("55") && fone.length === 13 && fone[4] === "9") v.push(fone.slice(0, 4) + fone.slice(5));
  if (fone.startsWith("55") && fone.length === 12 && /[6-9]/.test(fone[4])) v.push(fone.slice(0, 4) + "9" + fone.slice(4));
  return v;
}

// ---------------------------------------------------------------- Evolution
async function evoEnviarTexto(fone: string, text: string) {
  const key = await secret("EVO_JP_APIKEY", "evo_jp_apikey");
  if (!key) return { ok: false, erro: "Chave da instância JP (EVO_JP_APIKEY) não configurada" };
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${encodeURIComponent(INSTANCIA)}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ number: fone, text }),
    });
    const j = await r.json().catch(() => ({}));
    const id = j?.key?.id;
    if (!r.ok || !id) {
      const msg = j?.response?.message ?? j?.message ?? j?.error;
      return { ok: false, erro: `Evolution ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "").slice(0, 200)}` };
    }
    return { ok: true, id: id as string };
  } catch (e) {
    return { ok: false, erro: "Evolution fora do ar: " + String(e).slice(0, 150) };
  }
}

// ---------------------------------------------------------------- recebimento
function textoDaMensagem(msg: any, tipoEvo: string): { text: string; tipo: string | null } {
  const m = msg?.ephemeralMessage?.message || msg?.viewOnceMessage?.message || msg?.viewOnceMessageV2?.message || msg || {};
  if (m.conversation) return { text: m.conversation, tipo: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, tipo: null };
  if (m.imageMessage) return { text: "[📷 imagem]" + (m.imageMessage.caption ? " " + m.imageMessage.caption : ""), tipo: "image" };
  if (m.videoMessage) return { text: "[🎬 vídeo]" + (m.videoMessage.caption ? " " + m.videoMessage.caption : ""), tipo: "video" };
  if (m.audioMessage) return { text: "[🎤 áudio]", tipo: "audio" };
  if (m.documentMessage || m.documentWithCaptionMessage) {
    const d = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage || {};
    return { text: "[📎 documento] " + (d.fileName ?? ""), tipo: "file" };
  }
  if (m.stickerMessage) return { text: "[figurinha]", tipo: "image" };
  if (m.locationMessage) return { text: `[📍 localização] ${m.locationMessage.degreesLatitude ?? ""},${m.locationMessage.degreesLongitude ?? ""}`, tipo: null };
  if (m.contactMessage || m.contactsArrayMessage) return { text: "[👤 contato compartilhado]", tipo: null };
  if (m.reactionMessage) return { text: `[reagiu ${m.reactionMessage.text ?? ""}]`, tipo: null };
  if (m.buttonsResponseMessage) return { text: m.buttonsResponseMessage.selectedDisplayText ?? "", tipo: null };
  if (m.listResponseMessage) return { text: m.listResponseMessage.title ?? "", tipo: null };
  if (m.protocolMessage || m.senderKeyDistributionMessage) return { text: "", tipo: null }; // mensagem técnica: ignora
  return { text: `[${tipoEvo || "mensagem"}]`, tipo: null };
}

// telefone do outro lado da conversa (lida com o formato novo @lid do WhatsApp)
function foneDaConversa(d: any): string | null {
  const k = d?.key || {};
  const jid: string = k.remoteJid || "";
  if (!jid || jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "status@broadcast") return null;
  if (jid.endsWith("@lid")) {
    const alt = k.remoteJidAlt || k.senderPn || d?.senderPn || "";
    return digits(String(alt).split("@")[0]) || null;
  }
  return digits(jid.split("@")[0]) || null;
}

async function garantirConversa(fone: string, nome: string | null) {
  const fones = variantes(fone);
  // 1) já existe conversa jp para algum contato com esse telefone?
  const { data: existentes } = await sb.from("conversations").select("id, contact_id, is_archived, contacts!inner(phone)")
    .eq("channel", CANAL).in("contacts.phone", fones).limit(1);
  let conv: any = existentes?.[0] || null;
  if (conv) {
    if (conv.is_archived) await sb.from("conversations").update({ is_archived: false }).eq("id", conv.id);
    return conv.id as string;
  }
  // 2) contato geral da pessoa (qualquer canal), senão cria
  const { data: cts } = await sb.from("contacts").select("id, full_name").in("phone", fones).order("created_at", { ascending: false }).limit(1);
  let ct: any = cts?.[0] || null;
  if (!ct) {
    const ins = await sb.from("contacts").insert({ channel: CANAL, phone: fone, full_name: nome }).select("id, full_name").single();
    if (ins.error) {
      const again = await sb.from("contacts").select("id, full_name").in("phone", fones).limit(1);
      ct = again.data?.[0] || null;
    } else ct = ins.data;
  } else if (!ct.full_name && nome) {
    await sb.from("contacts").update({ full_name: nome }).eq("id", ct.id);
  }
  if (!ct) throw new Error("não consegui criar o contato " + fone);

  const ins = await sb.from("conversations").insert({ channel: CANAL, contact_id: ct.id, stage_id: STAGE_NOVO_LEAD, ia_ativa: false })
    .select("id").single();
  if (!ins.error) return ins.data.id as string;
  const again = await sb.from("conversations").select("id").eq("channel", CANAL).eq("contact_id", ct.id).maybeSingle();
  if (!again.data) throw new Error("não consegui criar a conversa " + fone + ": " + ins.error.message);
  return again.data.id as string;
}

async function processarMensagem(d: any) {
  const id = d?.key?.id;
  const fone = foneDaConversa(d);
  if (!id || !fone) return;
  const fromMe = !!d.key.fromMe;
  const { text, tipo } = textoDaMensagem(d.message, d.messageType);
  if (!text) return;

  if (fromMe) {
    // pode ser eco de uma mensagem que o próprio CRM enviou: dá tempo de o envio gravar o id
    await sleep(3000);
    const { data: ja } = await sb.from("messages").select("id").eq("ig_message_id", id).maybeSingle();
    if (ja) return;
  }

  const convId = await garantirConversa(fone, fromMe ? null : (d.pushName || null));
  const ins = await sb.from("messages").insert({
    conversation_id: convId,
    direction: fromMe ? "outbound" : "inbound",
    ig_message_id: id,
    sender_id: fromMe ? "celular" : fone,
    text, attachment_type: tipo,
    is_echo: fromMe,
    raw: { por: fromMe ? "celular" : "lead", key: d.key, messageType: d.messageType, pushName: d.pushName ?? null },
  });
  if (ins.error && !String(ins.error.message).includes("duplicate")) console.error("insert", ins.error.message);
}

// ---------------------------------------------------------------- envio pelo time
async function enviarDoCrm(messageId: string) {
  const { data: msg } = await sb.from("messages").select("id, conversation_id, text, ig_message_id, raw").eq("id", messageId).maybeSingle();
  if (!msg || msg.ig_message_id) return { ok: true, pulado: true };
  const { data: conv } = await sb.from("conversations").select("id, channel, contacts(phone)").eq("id", msg.conversation_id).single();
  if (!conv || conv.channel !== CANAL) return { ok: false, erro: "conversa não é do canal jp" };
  const fone = digits((conv as any).contacts?.phone);
  const marcaErro = (erro: string) => sb.from("messages").update({ raw: { ...(msg.raw || {}), erro } }).eq("id", msg.id);
  if (!fone) { await marcaErro("contato sem telefone"); return { ok: false }; }
  const env = await evoEnviarTexto(fone, msg.text || "");
  if (!env.ok) { await marcaErro(env.erro!); return { ok: false }; }
  await sb.from("messages").update({ ig_message_id: env.id, raw: { ...(msg.raw || {}), por: "time" } }).eq("id", msg.id);
  return { ok: true };
}

// ---------------------------------------------------------------- manutenção (ver / apontar o webhook da instância)
async function evo(method: string, path: string, body?: unknown) {
  const key = await secret("EVO_JP_APIKEY", "evo_jp_apikey");
  if (!key) return { status: 0, j: { erro: "EVO_JP_APIKEY não configurada" } };
  const r = await fetch(`${EVO_URL}${path}`, { method, headers: { apikey: key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const semSegredo = (x: any) => JSON.parse(JSON.stringify(x ?? {}).replace(/([?&]k=)[0-9a-f]+/gi, "$1***"));

async function status() {
  const con = await evo("GET", `/instance/connectionState/${encodeURIComponent(INSTANCIA)}`);
  const wh = await evo("GET", `/webhook/find/${encodeURIComponent(INSTANCIA)}`);
  return { conexao: con, webhook: semSegredo(wh) };
}

async function apontarWebhook() {
  const k = await secret("", "wa_jp_webhook_key");
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wa-jp?k=${k}`;
  // formato da Evolution v2; se a instalação for v1, tenta o formato antigo
  let r = await evo("POST", `/webhook/set/${encodeURIComponent(INSTANCIA)}`,
    { webhook: { enabled: true, url, byEvents: false, base64: false, events: ["MESSAGES_UPSERT"] } });
  if (r.status >= 400) {
    r = await evo("POST", `/webhook/set/${encodeURIComponent(INSTANCIA)}`,
      { enabled: true, url, webhook_by_events: false, webhook_base64: false, events: ["MESSAGES_UPSERT"] });
  }
  return semSegredo({ status: r.status, resposta: r.j });
}

// ---------------------------------------------------------------- servidor
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const url = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ ok: false, erro: "json inválido" }, 400); }

  // chamadas internas (gatilho do banco / manutenção): exigem o segredo interno
  if (body?.acao === "enviar" || body?.acao === "status" || body?.acao === "apontar_webhook") {
    const interno = await secret("", "wa_oficial_internal");
    if (!interno || req.headers.get("x-reino-secret") !== interno) return json({ ok: false }, 401);
    if (body.acao === "status") return json(await status());
    if (body.acao === "apontar_webhook") return json(await apontarWebhook());
    return json(await enviarDoCrm(String(body.message_id)));
  }

  // webhook da Evolution: precisa da chave na URL (?k=)
  const chave = await secret("", "wa_jp_webhook_key");
  if (!chave || url.searchParams.get("k") !== chave) return json({ ok: false }, 401);

  const evento = String(body?.event || "").toLowerCase().replace(/_/g, ".");
  if (evento !== "messages.upsert") return json({ ok: true, ignorado: evento });
  const lista = Array.isArray(body.data) ? body.data : (body.data?.messages || [body.data]);

  const trabalho = (async () => {
    for (const d of lista) { try { await processarMensagem(d); } catch (e) { console.error("mensagem", e); } }
  })();
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(trabalho); else await trabalho;
  return json({ ok: true });
});
