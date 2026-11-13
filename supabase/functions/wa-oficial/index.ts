// wa-oficial — Atendimento do WhatsApp Oficial (Cloud API) dentro do Reino CRM.
//
// Entradas:
//  GET  ?hub.mode=subscribe&hub.verify_token=...  -> verificação do webhook da Meta
//  POST (Meta)                                     -> mensagens recebidas + status de entrega
//  POST {acao:"enviar", message_id} + x-reino-secret -> envia o que o time escreveu no CRM
//  POST {acao:"fup"} + x-reino-secret               -> follow-ups vencidos (pg_cron a cada minuto)
//
// Funil "funil-diagnostico-whatsapp" (12/11/2026): a IA conduz em SPIN, apresenta o investimento,
// agenda a sessão de diagnóstico na Agenda Reino (Mateus/Thiago) e classifica o card sozinha:
//   Novo Lead · FUP1 nunca respondeu · FUP2 respondeu · FUP3 quase agendou · Agendado · FUP4 no show · FUP5 nutrição
// Follow-up quando o lead some: 10 min, 1 h, 6 h, 23 h depois da última mensagem dele, só entre 09h e 00h
// (o último ainda dentro da janela de 24 h da Meta, então não precisa de template).
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
const AGENDA = `${SUPABASE_URL}/functions/v1/agenda`;
const STAGE_NOVO_LEAD = "3441a20e-d74c-4315-b112-c96189c962b9";
const DEFAULT_PHONE_ID = "1095430970325134";
const DEBOUNCE_MS = 7000; // espera o lead terminar de digitar antes da IA responder
const PAUSA_HUMANO_H = 12; // quando o time responde, a IA fica quieta nessa conversa por X horas
const H = 3600_000, MIN = 60_000, OFFSET_BRT = 3 * H;

// fase -> etapa do kanban. Só movemos sozinhos cards que estão nestas etapas (nunca tiramos de Agendado, Venda etc.)
const ETAPA_DA_FASE: Record<string, string> = { novo: "Novo Lead", nunca: "FUP1", respondeu: "FUP2", quase: "FUP3", nutricao: "FUP5" };
const ETAPAS_AUTOMATICAS = ["Novo Lead", "FUP1", "FUP2", "FUP3", "FUP5"];
const FASES_SEM_FUP = ["agendado", "sem_interesse", "encerrado", "noshow", "transferido"];

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
// a IA às vezes escreve "\n" como texto: vira quebra de linha de verdade
const limparTexto = (s: unknown) => String(s ?? "").replace(/\\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const agoraBR = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

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

// ---------------------------------------------------------------- kanban
let etapasCache: Record<string, string> | null = null;
async function etapas() {
  if (etapasCache) return etapasCache;
  const { data } = await sb.from("kanban_stages").select("id,name");
  etapasCache = Object.fromEntries((data || []).map((s: any) => [s.name, s.id]));
  return etapasCache!;
}
// move o card para a etapa da fase, só se ele estiver numa etapa "automática" do funil.
// Novo Lead → FUP1 → FUP2 → FUP3 só avançam; FUP5 (nutrição) volta pro funil se o lead reaparecer.
const ORDEM: Record<string, number> = { "Novo Lead": 0, "FUP1": 1, "FUP2": 2, "FUP3": 3 };
async function moverFase(convId: string, fase: string) {
  const nomeEtapa = ETAPA_DA_FASE[fase];
  if (!nomeEtapa) return;
  const ids = await etapas();
  const { data: c } = await sb.from("conversations").select("stage_id, funil").eq("id", convId).single();
  if (!c?.funil) return;
  const atual = Object.entries(ids).find(([, id]) => id === c.stage_id)?.[0] ?? null;
  if (atual && !ETAPAS_AUTOMATICAS.includes(atual)) return;
  if (atual === nomeEtapa) return;
  if (atual && atual in ORDEM && nomeEtapa in ORDEM && ORDEM[nomeEtapa] < ORDEM[atual]) return;
  await sb.from("conversations").update({ stage_id: ids[nomeEtapa] }).eq("id", convId);
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

// baixa o áudio da Meta e manda pro fluxo de transcrição do n8n (Whisper). Falhou = segue sem texto.
async function transcreverAudio(mediaId: string, mime?: string): Promise<string> {
  try {
    const token = await secret("WA_TOKEN", "wa_oficial_token");
    const url = await secret("N8N_TRANSCRICAO_URL", "n8n_transcricao_url");
    if (!token || !url) return "";
    const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    if (!meta?.url) return "";
    const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!bin.ok) return "";
    const tipo = (mime || meta.mime_type || "audio/ogg").split(";")[0];
    const ext = tipo.includes("mpeg") ? "mp3" : tipo.includes("mp4") || tipo.includes("aac") ? "m4a" : tipo.includes("amr") ? "amr" : "ogg";
    const fd = new FormData();
    fd.append("audio", new Blob([await bin.arrayBuffer()], { type: tipo }), `audio.${ext}`);
    const r = await fetch(url, { method: "POST", body: fd, signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => ({}));
    return String(j?.text || "").trim().slice(0, 3000);
  } catch (e) {
    console.error("transcrição falhou", e);
    return "";
  }
}

async function garantirConversa(fone: string, nome: string | null, referral: any) {
  const funil = await config("oficial_funil", "funil-diagnostico-whatsapp");
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

  const campos = "id, ia_ativa, ia_pausada_ate, is_archived, funil, anuncio, origem";
  let { data: conv } = await sb.from("conversations").select(campos).eq("channel", "oficial").eq("contact_id", ct.id).maybeSingle();
  if (!conv) {
    const ins = await sb.from("conversations").insert({
      channel: "oficial", contact_id: ct.id, stage_id: STAGE_NOVO_LEAD, ia_ativa: true,
      funil, ia_fase: "novo", anuncio: referral || null, origem: referral ? "anuncio" : null,
    }).select(campos).single();
    if (ins.error) {
      const again = await sb.from("conversations").select(campos).eq("channel", "oficial").eq("contact_id", ct.id).maybeSingle();
      conv = again.data;
    } else conv = ins.data;
  } else {
    const patch: Record<string, unknown> = {};
    if (conv.is_archived) patch.is_archived = false;
    // conversa antiga entrando no funil agora: a IA passa a ler só daqui pra frente (não herda assunto velho)
    if (!conv.funil) { patch.funil = funil; patch.ia_contexto_desde = new Date(Date.now() - 1000).toISOString(); patch.ia_fase = "novo"; }
    if (referral && !conv.anuncio) { patch.anuncio = referral; if (!conv.origem) patch.origem = "anuncio"; }
    if (Object.keys(patch).length) await sb.from("conversations").update(patch).eq("id", conv.id);
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

  const referral = m.referral ? {
    source_type: m.referral.source_type ?? null, source_id: m.referral.source_id ?? null, source_url: m.referral.source_url ?? null,
    headline: m.referral.headline ?? null, body: m.referral.body ?? null, ctwa_clid: m.referral.ctwa_clid ?? null,
  } : null;
  const { contactId, conv } = await garantirConversa(fone, nome, referral);
  const ins = await sb.from("messages").insert({
    conversation_id: conv.id, direction: "inbound", ig_message_id: m.id, sender_id: fone,
    text, attachment_type: tipo, raw: m,
  }).select("id").single();
  if (ins.error) return null; // wamid repetido = a Meta reenviou; ignora
  waMarcarLida(m.id);
  // áudio: transcreve (n8n → Whisper) e grava o texto na mensagem, pra IA e o time lerem
  if (m.type === "audio" && m.audio?.id) {
    const t = await transcreverAudio(m.audio.id, m.audio.mime_type);
    if (t) await sb.from("messages").update({ text: `[🎤 áudio] ${t}` }).eq("id", ins.data.id);
  }

  // lead respondeu: para a sequência de follow-up e reclassifica
  const { data: fase } = await sb.from("conversations").select("ia_fase").eq("id", conv.id).single();
  await sb.from("conversations").update({
    fup_proximo_em: null, fup_n: 0,
    ...(["sem_interesse", "encerrado"].includes(fase?.ia_fase) ? { ia_fase: "respondeu" } : {}),
  }).eq("id", conv.id);
  const { data: ctx } = await sb.from("conversations").select("ia_contexto_desde").eq("id", conv.id).single();
  let qc = sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conv.id).eq("direction", "inbound");
  if (ctx?.ia_contexto_desde) qc = qc.gte("created_at", ctx.ia_contexto_desde);
  const { count } = await qc;
  if ((count ?? 0) >= 2) await moverFase(conv.id, "respondeu");
  return { convId: conv.id as string, contactId, msgId: ins.data.id as string, fone, nome };
}

// ---------------------------------------------------------------- agenda (ferramentas da IA)
function rotuloHorario(data: string, hora: string) {
  const [y, m, d] = data.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const [hh, mm] = hora.split(":");
  return `${SEMANA[dow]} (${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}) às ${Number(hh)}h${mm === "00" ? "" : mm}`;
}
async function verHorarios() {
  const r = await fetch(`${AGENDA}?acao=slots`);
  const j = await r.json().catch(() => ({}));
  const lista: { inicio: string; rotulo: string }[] = [];
  for (const dia of j.dias || []) for (const h of dia.horarios || []) {
    lista.push({ inicio: `${dia.data}T${h}:00-03:00`, rotulo: rotuloHorario(dia.data, h) });
  }
  if (!lista.length) return { horarios: [], aviso: "Agenda sem horários livres agora. Passe para o time (transferir_humano)." };
  return { horarios: lista.slice(0, 12) };
}
async function agendar(convId: string, fone: string, i: any, anuncio: any) {
  const funil = await config("oficial_funil", "funil-diagnostico-whatsapp");
  const r = await fetch(`${AGENDA}?acao=reservar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inicio: i.inicio, nome: i.nome, email: i.email, whatsapp: fone,
      evento: funil, origem: "WhatsApp Oficial · IA", conversation_id: convId,
      confirmar_lead: false, webhooks: false,
      respostas: { "Resumo da conversa": String(i.resumo || "").slice(0, 900), "Quando começaria": String(i.quando_comecaria || "").slice(0, 200) },
      utm: anuncio ? { utm_source: "meta_ctwa", utm_content: anuncio.source_id, utm_term: anuncio.headline } : null,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) return { ok: false, erro: j.erro || `agenda respondeu ${r.status}`, ja_agendado: j.ja_agendado ?? null };
  await sb.from("conversations").update({ ia_fase: "agendado", fup_proximo_em: null, fup_n: 0 }).eq("id", convId);
  return { ok: true, inicio: j.inicio, closer: j.closer, meet_link: j.meet_link, convite_por_email: j.convite_enviado };
}

// ---------------------------------------------------------------- IA
const FORMATO = `

COMO VOCÊ AGE (ferramentas)
- ver_horarios: traz os horários livres reais da agenda. Use antes de oferecer qualquer horário.
- agendar: reserva a sessão. Precisa de inicio (exatamente como veio de ver_horarios), nome completo e e-mail.
- responder: SEMPRE termine com ela. "resposta" é o texto que vai pro cliente no WhatsApp (vazio = não responder).
  "situacao": conversando | preco_apresentado | sem_interesse.
  "transferir_humano" = true quando precisar de alguém do time (explique em "motivo"; vale mesmo com "resposta" vazia).

QUANDO PARAR (regra dura)
- Qualquer retorno negativo encerra a conversa: "foi engano", "cliquei sem querer", "não tenho interesse", "não quero", "agora não", "para de me mandar", "não é pra mim", número errado, xingamento, ou só uma despedida.
- Nesse caso use situacao "sem_interesse". Responda no máximo UMA despedida curta e educada (ex.: "Sem problema, desculpa o incômodo! 🙏") ou deixe "resposta" vazia. NÃO faça mais pergunta, NÃO insista, NÃO tente reverter.
- Se a conversa já terminou (você já se despediu), deixe "resposta" vazia.`;

const TOOLS = [
  { name: "ver_horarios", description: "Lista os próximos horários livres da sessão de diagnóstico (1 h, Google Meet).", input_schema: { type: "object", properties: {} } },
  {
    name: "agendar", description: "Reserva a sessão de diagnóstico no horário escolhido pelo cliente.",
    input_schema: {
      type: "object",
      properties: {
        inicio: { type: "string", description: "Valor 'inicio' exatamente como veio de ver_horarios" },
        nome: { type: "string", description: "Nome completo do cliente" },
        email: { type: "string", description: "E-mail do cliente (recebe o convite)" },
        resumo: { type: "string", description: "Resumo em 2-4 linhas: o que faz, como vende hoje, o que trava, o que quer" },
        quando_comecaria: { type: "string", description: "O que respondeu sobre quando começaria" },
      },
      required: ["inicio", "nome", "email", "resumo"],
    },
  },
  {
    name: "responder", description: "Responde o cliente no WhatsApp e encerra o turno.",
    input_schema: {
      type: "object",
      properties: {
        resposta: { type: "string", description: "Texto para enviar ao cliente (vazio = não responder)" },
        situacao: { type: "string", enum: ["conversando", "preco_apresentado", "sem_interesse"] },
        transferir_humano: { type: "boolean" },
        motivo: { type: "string", description: "Por que transferiu (vazio se não transferiu)" },
      },
      required: ["resposta", "transferir_humano"],
    },
  },
];

async function historico(convId: string) {
  const { data: cv } = await sb.from("conversations").select("ia_contexto_desde").eq("id", convId).single();
  let q = sb.from("messages").select("direction, text, created_at").eq("conversation_id", convId);
  if (cv?.ia_contexto_desde) q = q.gte("created_at", cv.ia_contexto_desde);
  const { data: hist } = await q.order("created_at", { ascending: false }).limit(40);
  const msgs: { role: "user" | "assistant"; content: any }[] = [];
  for (const h of (hist || []).reverse()) {
    const role = h.direction === "inbound" ? "user" : "assistant";
    const t = (h.text || "").trim();
    if (!t) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += "\n" + t;
    else msgs.push({ role, content: t });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

async function montarSistema(conv: any, fone: string, nome: string | null, extra = "") {
  const a = conv.anuncio;
  return (await config("oficial_ia_prompt")) + FORMATO + extra +
    `\n\nDADOS DO CLIENTE\nNome no WhatsApp: ${nome || "(sem nome)"}\nTelefone: ${fone}\nAgora: ${agoraBR()}` +
    (a ? `\nVeio do anúncio: ${[a.headline, a.body].filter(Boolean).join(" — ").slice(0, 400) || "(sem texto)"}` : "") +
    (conv.ia_fase === "agendado" && conv.agenda_inicio ? `\nJÁ AGENDADO para ${new Date(conv.agenda_inicio).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}${conv.agenda_link ? " · " + conv.agenda_link : ""}` : "");
}

async function chamarClaude(apiKey: string, modelo: string, system: string, messages: any[], tools: any[], toolChoice: any) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: modelo, max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages, tools, tool_choice: toolChoice,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

// próximo horário permitido (09h–00h de Brasília) que ainda caiba antes do limite (janela de 24 h)
function ajustarHorario(t: number, limite: number): number | null {
  const horaBR = new Date(t - OFFSET_BRT).getUTCHours();
  let cand = t;
  if (horaBR < 9) {
    const d = new Date(t - OFFSET_BRT);
    cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9) + OFFSET_BRT;
    if (cand > limite) {
      // 09h já passa da janela: manda às 23h50 da véspera, se ainda der tempo
      const anterior = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0) + OFFSET_BRT - 10 * MIN;
      cand = anterior > Date.now() + MIN ? anterior : NaN;
    }
  }
  if (!Number.isFinite(cand) || cand > limite) return null;
  return Math.max(cand, Date.now() + 30_000);
}
async function minutosFup(): Promise<number[]> {
  return (await config("oficial_fup_minutos", "10,60,360,1380")).split(",").map((x) => Number(x.trim())).filter((n) => n > 0);
}
// agenda o follow-up de número n (1..4) contando a partir da última mensagem do lead
async function agendarFup(convId: string, n: number) {
  if ((await config("oficial_fup_ativo", "true")) !== "true") return;
  const offs = await minutosFup();
  const { data: c } = await sb.from("conversations").select("last_inbound_at, ia_fase").eq("id", convId).single();
  if (!c?.last_inbound_at || FASES_SEM_FUP.includes(c.ia_fase)) return;
  const base = new Date(c.last_inbound_at).getTime();
  const limite = base + 24 * H - 15 * MIN;
  for (let k = n; k <= offs.length; k++) {
    const quando = ajustarHorario(base + offs[k - 1] * MIN, limite);
    if (quando) {
      await sb.from("conversations").update({ fup_n: k - 1, fup_proximo_em: new Date(quando).toISOString() }).eq("id", convId);
      return;
    }
  }
  // não cabe mais nenhum follow-up na janela: encerra em nutrição
  await sb.from("conversations").update({ fup_proximo_em: null, ia_fase: "encerrado" }).eq("id", convId);
  await moverFase(convId, "nutricao");
}

async function rodarIA(convId: string, msgId: string, fone: string, nome: string | null) {
  if ((await config("oficial_ia_ativa", "true")) !== "true") return;

  // espera o lead parar de digitar; só a última mensagem dispara a IA
  await sleep(DEBOUNCE_MS);
  const { data: ultima } = await sb.from("messages").select("id").eq("conversation_id", convId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (ultima?.id !== msgId) return;

  const { data: conv } = await sb.from("conversations").select("ia_ativa, ia_pausada_ate, ia_fase, anuncio, agenda_inicio, agenda_link, funil").eq("id", convId).single();
  if (!conv || conv.ia_ativa === false) return;
  if (conv.ia_pausada_ate && new Date(conv.ia_pausada_ate) > new Date()) return;

  const apiKey = await secret("ANTHROPIC_API_KEY", "anthropic_api_key");
  if (!apiKey) { console.error("ANTHROPIC_API_KEY não configurada"); return; }
  const msgs = await historico(convId);
  if (!msgs.length) return;

  const system = await montarSistema(conv, fone, nome);
  const modelo = await config("oficial_ia_modelo", "claude-sonnet-5");

  // laço de ferramentas: ver_horarios / agendar até a IA chamar "responder"
  let out: any = null, viuHorarios = false, agendou = false;
  for (let volta = 0; volta < 5 && !out; volta++) {
    const j = await chamarClaude(apiKey, modelo, system, msgs, TOOLS, { type: "any" });
    const usos = (j.content || []).filter((c: any) => c.type === "tool_use");
    const final = usos.find((u: any) => u.name === "responder");
    if (final) { out = final.input; break; }
    const resultados: any[] = [];
    for (const u of usos) {
      let res: unknown;
      try {
        if (u.name === "ver_horarios") { res = await verHorarios(); viuHorarios = true; }
        else if (u.name === "agendar") { res = await agendar(convId, fone, u.input, conv.anuncio); if ((res as any).ok) agendou = true; }
        else res = { erro: "ferramenta desconhecida" };
      } catch (e) { res = { erro: String(e).slice(0, 200) }; }
      resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(res) });
    }
    if (!resultados.length) break;
    msgs.push({ role: "assistant", content: j.content });
    msgs.push({ role: "user", content: resultados });
  }
  if (!out) { console.error("IA não chegou na resposta final", convId); return; }

  const resposta = limparTexto(out.resposta);
  if (!resposta && !out.transferir_humano && out.situacao !== "sem_interesse") return;

  // o time pode ter assumido enquanto a IA pensava
  const { data: c2 } = await sb.from("conversations").select("ia_ativa, ia_pausada_ate").eq("id", convId).single();
  if (c2?.ia_ativa === false || (c2?.ia_pausada_ate && new Date(c2.ia_pausada_ate) > new Date())) return;

  if (resposta) {
    const env = await waEnviarTexto(fone, resposta);
    await sb.from("messages").insert({
      conversation_id: convId, direction: "outbound", text: resposta, sender_id: "ia",
      ig_message_id: env.ok ? env.wamid : null,
      raw: env.ok ? { por: "ia" } : { por: "ia", erro: env.erro },
    });
  }

  // classificação + follow-up
  if (out.transferir_humano) {
    await sb.from("conversations").update({
      ia_ativa: false, ia_fase: "transferido", fup_proximo_em: null,
      next_action: "🤖 IA passou pro time: " + (out.motivo || "precisa de humano"),
      next_action_at: new Date().toISOString().slice(0, 10),
    }).eq("id", convId);
    return;
  }
  if (agendou) return; // a agenda já moveu o card para Agendado
  if (out.situacao === "sem_interesse") {
    await sb.from("conversations").update({ ia_fase: "sem_interesse", fup_proximo_em: null }).eq("id", convId);
    await moverFase(convId, "nutricao");
    return;
  }
  if (conv.ia_fase === "agendado") return;
  if (viuHorarios) {
    await sb.from("conversations").update({ ia_fase: "horarios" }).eq("id", convId);
    await moverFase(convId, "quase");
  } else if (out.situacao === "preco_apresentado" && !["horarios"].includes(conv.ia_fase)) {
    await sb.from("conversations").update({ ia_fase: "preco" }).eq("id", convId);
  }
  if (resposta) await agendarFup(convId, 1);
}

// ---------------------------------------------------------------- follow-up (pg_cron a cada minuto)
const MODO_FUP = (n: number, total: number) => `

MODO FOLLOW-UP
O cliente parou de responder. Este é o follow-up ${n} de ${total}.
Escreva UMA mensagem curta (1 ou 2 frases), natural, retomando exatamente de onde a conversa parou — sem repetir o que já disse, sem pressão e sem "só passando pra lembrar".
${n === 1 ? "Retome a última pergunta de um jeito leve." : ""}${n === 2 ? "Traga um motivo concreto pra continuar, ligado ao que ele contou." : ""}${n === 3 ? "Pergunte se ainda faz sentido conversar agora ou se prefere em outro momento." : ""}${n >= total ? "É a última: deixe a porta aberta com carinho e diga que fica à disposição." : ""}
Se a conversa estava em horários, ofereça de novo (use ver_horarios). Não use agendar neste modo. Termine com responder.
ANTES DE ESCREVER: se o cliente deu qualquer retorno negativo (engano, sem interesse, agora não, pediu pra parar), se despediu, ou se você já se despediu, NÃO mande nada: "resposta" vazia e situacao "sem_interesse".`;

async function processarFups() {
  const { data: vencidos } = await sb.from("conversations")
    .select("id, fup_n, fup_proximo_em, ia_ativa, ia_pausada_ate, ia_fase, anuncio, agenda_inicio, agenda_link, last_inbound_at, funil, contacts(phone, full_name)")
    .eq("channel", "oficial").lte("fup_proximo_em", new Date().toISOString()).limit(15);
  let enviados = 0;
  for (const c of vencidos || []) {
    // reserva o follow-up (outra execução não pega o mesmo)
    const { data: pego } = await sb.from("conversations").update({ fup_proximo_em: null })
      .eq("id", c.id).eq("fup_proximo_em", c.fup_proximo_em).select("id");
    if (!pego?.length) continue;
    try {
      if ((await config("oficial_fup_ativo", "true")) !== "true") continue;
      if (c.ia_ativa === false || (c.ia_pausada_ate && new Date(c.ia_pausada_ate) > new Date())) continue;
      if (FASES_SEM_FUP.includes(c.ia_fase)) continue;
      const { data: ult } = await sb.from("messages").select("direction").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (ult?.direction !== "outbound") continue; // o lead respondeu: a IA cuida
      if (!c.last_inbound_at || Date.now() > new Date(c.last_inbound_at).getTime() + 24 * H - 5 * MIN) continue; // janela fechou

      const fone = digits((c as any).contacts?.phone);
      const nome = (c as any).contacts?.full_name ?? null;
      const total = (await minutosFup()).length;
      const n = (c.fup_n || 0) + 1;
      const apiKey = await secret("ANTHROPIC_API_KEY", "anthropic_api_key");
      const modelo = await config("oficial_ia_modelo", "claude-sonnet-5");
      const msgs = await historico(c.id);
      if (!msgs.length || !fone) continue;
      if (msgs[msgs.length - 1].role === "assistant") msgs.push({ role: "user", content: "[sem resposta do cliente]" });
      const system = await montarSistema(c, fone, nome, MODO_FUP(n, total));
      const tools = TOOLS.filter((t) => t.name !== "agendar");
      let out: any = null, viuHorarios = false;
      for (let volta = 0; volta < 3 && !out; volta++) {
        const j = await chamarClaude(apiKey, modelo, system, msgs, tools, { type: "any" });
        const usos = (j.content || []).filter((x: any) => x.type === "tool_use");
        const final = usos.find((u: any) => u.name === "responder");
        if (final) { out = final.input; break; }
        const res: any[] = [];
        for (const u of usos) { res.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(u.name === "ver_horarios" ? await verHorarios() : { erro: "indisponível" }) }); if (u.name === "ver_horarios") viuHorarios = true; }
        if (!res.length) break;
        msgs.push({ role: "assistant", content: j.content }, { role: "user", content: res });
      }
      const texto = limparTexto(out?.resposta);
      // retorno negativo / conversa encerrada: não manda nada e tira da sequência
      if (out?.situacao === "sem_interesse" || !texto) {
        await sb.from("conversations").update({ fup_proximo_em: null, ia_fase: out?.situacao === "sem_interesse" ? "sem_interesse" : "encerrado" }).eq("id", c.id);
        await moverFase(c.id, "nutricao");
        continue;
      }
      const env = await waEnviarTexto(fone, texto);
      await sb.from("messages").insert({
        conversation_id: c.id, direction: "outbound", text: texto, sender_id: "ia",
        ig_message_id: env.ok ? env.wamid : null,
        raw: env.ok ? { por: "ia", fup: n } : { por: "ia", fup: n, erro: env.erro },
      });
      enviados++;
      if (n === 1) await moverFase(c.id, "nunca"); // só sai de Novo Lead (FUP2/FUP3 não voltam)
      if (viuHorarios && c.ia_fase !== "horarios") { await sb.from("conversations").update({ ia_fase: "horarios" }).eq("id", c.id); await moverFase(c.id, "quase"); }
      if (n >= total) {
        await sb.from("conversations").update({ fup_n: n, ia_fase: "encerrado" }).eq("id", c.id);
        await moverFase(c.id, "nutricao");
      } else {
        await agendarFup(c.id, n + 1);
      }
    } catch (e) { console.error("fup", c.id, e); }
  }
  return { ok: true, vencidos: vencidos?.length ?? 0, enviados };
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
  // time respondeu: IA (e follow-up) ficam quietos por um tempo nessa conversa
  await sb.from("conversations").update({ ia_pausada_ate: new Date(Date.now() + PAUSA_HUMANO_H * 3600 * 1000).toISOString(), fup_proximo_em: null }).eq("id", conv.id);
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

  // chamadas internas (gatilho do banco / pg_cron)
  if (body?.acao === "enviar" || body?.acao === "fup") {
    const interno = await secret("WA_INTERNAL_SECRET", "wa_oficial_internal");
    if (!interno || req.headers.get("x-reino-secret") !== interno) return json({ ok: false }, 401);
    if (body.acao === "fup") return json(await processarFups());
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
