// wa-cris — WhatsApp da Cris (Evolution, instância "Crisv2", número não oficial) na tela de Atendimento do Reino CRM.
// Criado em 16/11/2026 a partir do wa-jp.
//
//  POST (Evolution, evento messages.upsert, ?k=wa_cris_webhook_key) -> grava conversa/mensagem com channel = 'cris'
//  POST {acao:"enviar", message_id} + x-reino-secret               -> envia o que o time escreveu no CRM
//
// Envio: a chave da instância Crisv2 fica só na credencial "CRIS V3" do n8n, então a função chama o
// webhook do n8n "Cris · Enviar do CRM" (URL em app_secrets.n8n_cris_enviar_url), que devolve a resposta da Evolution.
// Repasse: tudo que chega é reenviado pro webhook antigo da instância (app_secrets.wa_cris_relay_url), pra não
// quebrar quem já escutava a Crisv2.
// Sem IA (só o time responde). Ignora grupos, status e newsletters. Mensagens que o celular manda (fromMe) entram
// como saída — inclusive as automações (confirmação de agendamento, abordagem do funil). Avisos internos pro time
// (números do Thiago e do Mateus) não viram conversa.

import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CANAL = "cris";
const STAGE_NOVO_LEAD = "3441a20e-d74c-4315-b112-c96189c962b9";
const NAO_REGISTRAR = ["5521996661173", "5521972912858"]; // Thiago e Mateus: avisos internos, não é lead

const secretCache = new Map<string, string>();
async function secret(tableKey: string): Promise<string> {
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

// ---------------------------------------------------------------- envio (via n8n)
async function enviarTexto(fone: string, text: string) {
  const url = await secret("n8n_cris_enviar_url");
  if (!url) return { ok: false, erro: "URL de envio da Cris (n8n_cris_enviar_url) não configurada" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: fone, text }),
      signal: AbortSignal.timeout(30_000),
    });
    let j: any = await r.json().catch(() => ({}));
    if (Array.isArray(j)) j = j[0] || {};
    const id = j?.key?.id;
    if (!r.ok || !id) {
      const msg = j?.response?.message ?? j?.message ?? j?.error;
      return { ok: false, erro: `Envio ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "").slice(0, 200)}` };
    }
    return { ok: true, id: id as string };
  } catch (e) {
    return { ok: false, erro: "n8n/Evolution fora do ar: " + String(e).slice(0, 150) };
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
  if (m.protocolMessage || m.senderKeyDistributionMessage) return { text: "", tipo: null };
  return { text: `[${tipoEvo || "mensagem"}]`, tipo: null };
}

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
  const { data: existentes } = await sb.from("conversations").select("id, contact_id, is_archived, contacts!inner(phone)")
    .eq("channel", CANAL).in("contacts.phone", fones).limit(1);
  const conv: any = existentes?.[0] || null;
  if (conv) {
    if (conv.is_archived) await sb.from("conversations").update({ is_archived: false }).eq("id", conv.id);
    return conv.id as string;
  }
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
  if (variantes(fone).some((f) => NAO_REGISTRAR.includes(f))) return;
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
  if (!conv || conv.channel !== CANAL) return { ok: false, erro: "conversa não é do canal cris" };
  const fone = digits((conv as any).contacts?.phone);
  const marcaErro = (erro: string) => sb.from("messages").update({ raw: { ...(msg.raw || {}), erro } }).eq("id", msg.id);
  if (!fone) { await marcaErro("contato sem telefone"); return { ok: false }; }
  const env = await enviarTexto(fone, msg.text || "");
  if (!env.ok) { await marcaErro(env.erro!); return { ok: false }; }
  await sb.from("messages").update({ ig_message_id: env.id, raw: { ...(msg.raw || {}), por: "time" } }).eq("id", msg.id);
  return { ok: true };
}

// ---------------------------------------------------------------- servidor
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const url = new URL(req.url);
  const raw = await req.text();
  let body: any = {};
  try { body = JSON.parse(raw); } catch (_) { return json({ ok: false, erro: "json inválido" }, 400); }

  if (body?.acao === "enviar") {
    const interno = await secret("wa_oficial_internal");
    if (!interno || req.headers.get("x-reino-secret") !== interno) return json({ ok: false }, 401);
    return json(await enviarDoCrm(String(body.message_id)));
  }

  // webhook da Evolution: precisa da chave na URL (?k=)
  const chave = await secret("wa_cris_webhook_key");
  if (!chave || url.searchParams.get("k") !== chave) return json({ ok: false }, 401);

  const trabalho = (async () => {
    // repasse pro webhook antigo da instância (quem já escutava a Crisv2 continua recebendo)
    const relay = await secret("wa_cris_relay_url");
    if (relay) await fetch(relay, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    const evento = String(body?.event || "").toLowerCase().replace(/_/g, ".");
    if (evento !== "messages.upsert") return;
    const lista = Array.isArray(body.data) ? body.data : (body.data?.messages || [body.data]);
    for (const d of lista) { try { await processarMensagem(d); } catch (e) { console.error("mensagem", e); } }
  })();
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(trabalho); else await trabalho;
  return json({ ok: true });
});
