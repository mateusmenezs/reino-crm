import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * agenda — o "Calendly" da Reino.
 *
 *   GET  ?acao=slots[&closer=mateus|thiago]   -> horarios livres (uniao dos closers)
 *   POST ?acao=reservar  {inicio, nome, email, whatsapp, ...} -> cria a reuniao
 *
 * Endpoint publico (verify_jwt = false): o widget roda no site, sem login.
 *
 * Ocupado = public.agenda_eventos + public.agenda_reservas.
 * Leads do JP (SDR IA) moram no canal proprio "jp" (funil hermes-sdr); os demais, em "whatsapp".
 *
 * Opcionais no reservar (12/11/2026, usados pela IA do WhatsApp Oficial):
 *   conversation_id   -> move ESSA conversa para Agendado (não cria card em outro canal)
 *   confirmar_lead:false -> não manda a confirmação da Cris (a IA confirma no próprio chat)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};
const OFFSET_H = 3;
const MIN = 60_000;

type Closer = {
  nome: string;
  calendar_id: string;
  calendar_id_evento?: string;
  webhook: string;
  ativo: boolean;
  horarios: Record<string, [string, string][]>;
};
type Config = {
  duracao_min: number;
  intervalo_min: number;
  passo_min: number;
  antecedencia_min_horas: number;
  janela_dias: number;
  dias_uteis_max?: number;
  pular_feriados: boolean;
  titulo_evento: string;
  closers: Record<string, Closer>;
  aviso_whatsapp?: string;
  aviso_webhook?: string;
  crm_webhook?: string | null;
  n8n_evento_webhook?: string;
  n8n_token?: string;
  webhooks_agendado?: string[];
  cris_webhook?: string;
  cris_confirmacao?: string;
};

const SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function horaFalada(hhmm: string) {
  const [h, m] = hhmm.split(":");
  return `${Number(h)}h${m === "00" ? "" : m}`;
}

async function moveCardAgendado(p: {
  nome: string; email: string; whatsapp: string; instagram: string; funil: string;
  utm: Record<string, unknown> | null; respostas: Record<string, unknown> | null;
  closer: string; inicio: number; meet: string | null; eventId: string; origem: string;
  convId?: string | null;
}) {
  const { data: etapas } = await sb.from("kanban_stages").select("id,name").in("name", ["Agendado", "Novo Lead"]);
  const etapa = (n: string) => (etapas ?? []).find((e) => e.name === n)?.id;
  const agendado = etapa("Agendado");
  if (!agendado) throw new Error("etapa Agendado nao encontrada");
  const tag = p.funil.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const insta = p.instagram.replace(/^@/, "");
  const chan = p.funil === "hermes-sdr" ? "jp" : "whatsapp";

  // conversa já conhecida (ex.: IA do WhatsApp Oficial): usa ela e só etiqueta o contato
  let conv: { id: string; notes: string | null; qualificacao: Record<string, unknown> | null } | undefined;
  if (p.convId) {
    const { data } = await sb.from("conversations").select("id,notes,qualificacao,contact_id").eq("id", p.convId).maybeSingle();
    if (data) {
      conv = data;
      const { data: ct } = await sb.from("contacts").select("id,tags,full_name,email").eq("id", data.contact_id).maybeSingle();
      if (ct) {
        const tags: string[] = Array.isArray(ct.tags) ? [...ct.tags] : [];
        if (!tags.includes(tag)) tags.push(tag);
        await sb.from("contacts").update({
          tags,
          ...(ct.full_name ? {} : { full_name: p.nome }),
          ...(ct.email ? {} : { email: p.email }),
        }).eq("id", ct.id);
      }
    }
  }

  if (!conv) {
    let { data: cs } = await sb.from("contacts").select("id,tags,full_name,email,username").eq("phone", p.whatsapp).limit(1);
    if (!cs?.length) ({ data: cs } = await sb.from("contacts").select("id,tags,full_name,email,username").ilike("email", p.email).limit(1));
    let contato = cs?.[0];
    if (contato) {
      const tags: string[] = Array.isArray(contato.tags) ? [...contato.tags] : [];
      if (!tags.includes(tag)) tags.push(tag);
      await sb.from("contacts").update({
        tags,
        ...(contato.full_name ? {} : { full_name: p.nome }),
        ...(contato.email ? {} : { email: p.email }),
        ...(contato.username || !insta ? {} : { username: insta }),
      }).eq("id", contato.id);
    } else {
      const { data, error } = await sb.from("contacts").insert({
        channel: "whatsapp", full_name: p.nome, phone: p.whatsapp, email: p.email, username: insta || null, tags: [tag],
      }).select("id").single();
      if (error) throw error;
      contato = data;
    }

    const { data: convs } = await sb.from("conversations").select("id,notes,qualificacao")
      .eq("contact_id", contato!.id).eq("channel", chan).order("created_at", { ascending: false }).limit(1);
    conv = convs?.[0];
    if (!conv) {
      const { data, error } = await sb.from("conversations").insert({
        contact_id: contato!.id, channel: chan, stage_id: etapa("Novo Lead") ?? null, funil: p.funil,
      }).select("id,notes,qualificacao").single();
      if (error) throw error;
      conv = data;
    }
  }

  const { data: dataTxt, hora } = diaBRT(p.inicio);
  const [, mm, dd] = dataTxt.split("-");
  const nota = `[${new Date().toISOString().slice(0, 16).replace("T", " ")}] Agendou pela agenda do site: ${dd}/${mm} ${hora} com ${p.closer}` +
    ` | funil: ${p.funil}` + (p.utm?.utm_source ? ` | utm: ${[p.utm.utm_source, p.utm.utm_campaign].filter(Boolean).join(" / ")}` : "");
  const { error } = await sb.from("conversations").update({
    stage_id: agendado,
    agenda_inicio: new Date(p.inicio).toISOString(),
    agenda_link: p.meet || "(sem link do Meet — ver agenda do Google)",
    agenda_event_id: p.eventId,
    funil: p.funil,
    next_action: "Call agendada",
    next_action_at: dataTxt,
    is_archived: false,
    qualificacao: { ...(conv!.qualificacao ?? {}), ...(p.respostas ?? {}), utm: p.utm ?? undefined, closer: p.closer, origem: p.origem || undefined },
    notes: [conv!.notes, nota].filter(Boolean).join("\n"),
  }).eq("id", conv!.id);
  if (error) throw error;
  return conv!.id as string;
}
type Intervalo = { ini: number; fim: number };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function limpa(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}
function diaBRT(ms: number) {
  const d = new Date(ms - OFFSET_H * 3600_000);
  return {
    data: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    dow: d.getUTCDay(),
    hora: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}
function instanteBRT(data: string, hhmm: string): number {
  const [y, m, d] = data.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h + OFFSET_H, mi);
}
function isoBRT(ms: number) {
  const d = new Date(ms - OFFSET_H * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00-03:00`;
}

const feriadosCache: Record<number, Set<string>> = {};
async function feriados(ano: number): Promise<Set<string>> {
  if (feriadosCache[ano]) return feriadosCache[ano];
  try {
    const r = await fetch(`https://brasilapi.com.br/api/feriados/v1/${ano}`, {
      signal: AbortSignal.timeout(4000),
    });
    const lista = r.ok ? await r.json() : [];
    feriadosCache[ano] = new Set((lista as { date: string }[]).map((f) => f.date));
  } catch {
    return new Set();
  }
  return feriadosCache[ano];
}

async function carregaConfig(): Promise<Config> {
  const { data, error } = await sb.from("agenda_config").select("config").eq("id", 1).single();
  if (error || !data) throw new Error("agenda_config ausente");
  return data.config as Config;
}

async function ocupados(cfg: Config, deMs: number, ateMs: number) {
  const porCal: Record<string, string> = {};
  for (const [k, c] of Object.entries(cfg.closers)) porCal[c.calendar_id] = k;
  const folga = cfg.intervalo_min * MIN;
  const out: Record<string, Intervalo[]> = {};
  for (const k of Object.keys(cfg.closers)) out[k] = [];

  const de = new Date(deMs).toISOString();
  const ate = new Date(ateMs).toISOString();
  const [ev, rs] = await Promise.all([
    sb.from("agenda_eventos").select("calendar_id,inicio,fim,all_day,status")
      .in("calendar_id", Object.keys(porCal)).lt("inicio", ate).gt("fim", de),
    sb.from("agenda_reservas").select("closer,inicio,fim")
      .eq("status", "confirmado").lt("inicio", ate).gt("fim", de),
  ]);
  if (ev.error) throw ev.error;
  if (rs.error) throw rs.error;

  for (const e of ev.data ?? []) {
    if (e.all_day || e.status === "cancelled" || !e.fim) continue;
    const k = porCal[e.calendar_id];
    if (!k) continue;
    out[k].push({ ini: Date.parse(e.inicio) - folga, fim: Date.parse(e.fim) + folga });
  }
  for (const r of rs.data ?? []) {
    if (!out[r.closer]) continue;
    out[r.closer].push({ ini: Date.parse(r.inicio) - folga, fim: Date.parse(r.fim) + folga });
  }
  return out;
}

function livre(busy: Intervalo[], ini: number, fim: number) {
  return !busy.some((b) => ini < b.fim && fim > b.ini);
}

async function diasPermitidos(cfg: Config, agora: number) {
  const out: { data: string; dow: number }[] = [];
  let uteis = 0;
  for (let i = 0; i <= cfg.janela_dias; i++) {
    const dia = diaBRT(agora + i * 86400_000);
    if (cfg.pular_feriados && (await feriados(Number(dia.data.slice(0, 4)))).has(dia.data)) continue;
    if (i > 0 && dia.dow >= 1 && dia.dow <= 5) uteis++;
    if (cfg.dias_uteis_max && uteis > cfg.dias_uteis_max) break;
    out.push(dia);
  }
  return out;
}

async function slotsDoCloser(cfg: Config, closer: Closer, busy: Intervalo[], agora: number) {
  const dur = cfg.duracao_min * MIN;
  const passo = cfg.passo_min * MIN;
  const cedo = agora + cfg.antecedencia_min_horas * 3600_000;
  const out: number[] = [];
  for (const { data, dow } of await diasPermitidos(cfg, agora)) {
    for (const [a, b] of closer.horarios[String(dow)] ?? []) {
      const fimJanela = instanteBRT(data, b);
      for (let t = instanteBRT(data, a); t + dur <= fimJanela; t += passo) {
        if (t >= cedo && livre(busy, t, t + dur)) out.push(t);
      }
    }
  }
  return out;
}

function closersAtivos(cfg: Config, pedido: string | null) {
  return Object.entries(cfg.closers).filter(([k, c]) => c.ativo && (!pedido || k === pedido));
}

async function acaoSlots(url: URL) {
  const cfg = await carregaConfig();
  const agora = Date.now();
  const ate = agora + (cfg.janela_dias + 1) * 86400_000;
  const busy = await ocupados(cfg, agora, ate);
  const todos = new Set<number>();
  for (const [k, c] of closersAtivos(cfg, url.searchParams.get("closer"))) {
    for (const t of await slotsDoCloser(cfg, c, busy[k], agora)) todos.add(t);
  }
  const dias: Record<string, string[]> = {};
  for (const t of [...todos].sort((a, b) => a - b)) {
    const { data, hora } = diaBRT(t);
    (dias[data] ??= []).push(hora);
  }
  return json({
    fuso: "America/Sao_Paulo",
    duracao_min: cfg.duracao_min,
    dias: Object.entries(dias).map(([data, horarios]) => ({ data, horarios })),
  });
}

function normWpp(raw: string) {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
}

async function postaComTimeout(url: string | undefined, corpo: unknown) {
  if (!url) return;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`${url} respondeu ${r.status}`);
}

async function acaoReservar(req: Request) {
  let d: Record<string, unknown>;
  try {
    const bruto = await req.text();
    if (!bruto || bruto.length > 10000) return json({ erro: "corpo invalido" }, 400);
    d = JSON.parse(bruto);
  } catch {
    return json({ erro: "json invalido" }, 400);
  }
  if (limpa(d.site, 200)) return json({ ok: true });

  const nome = limpa(d.nome, 120);
  const email = limpa(d.email, 160).toLowerCase();
  const whatsapp = normWpp(limpa(d.whatsapp, 25));
  let instagram = limpa(d.instagram, 60).replace(/^@+/, "");
  if (instagram) instagram = "@" + instagram;
  const inicio = Date.parse(limpa(d.inicio, 40));
  const convIdPedido = limpa(d.conversation_id, 40) || null;

  if (nome.length < 3) return json({ erro: "Informe seu nome completo." }, 422);
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return json({ erro: "E-mail inválido." }, 422);
  if (whatsapp.length < 12 || whatsapp.length > 15) return json({ erro: "WhatsApp inválido (use DDD + número)." }, 422);
  if (!Number.isFinite(inicio)) return json({ erro: "Horário inválido." }, 422);

  const cfg = await carregaConfig();
  const agora = Date.now();
  const fim = inicio + cfg.duracao_min * MIN;

  const { data: jaTem } = await sb.from("agenda_reservas")
    .select("inicio,closer,meet_link").eq("status", "confirmado").gt("inicio", new Date(agora).toISOString())
    .or(`email.eq.${email},whatsapp.eq.${whatsapp}`).limit(1);
  if (jaTem && jaTem[0]) {
    return json({
      erro: "Você já tem um horário marcado com a gente.",
      ja_agendado: { inicio: isoBRT(Date.parse(jaTem[0].inicio)), meet_link: jaTem[0].meet_link },
    }, 409);
  }

  const busy = await ocupados(cfg, agora, agora + (cfg.janela_dias + 1) * 86400_000);
  const candidatos: string[] = [];
  for (const [k, c] of closersAtivos(cfg, limpa(d.closer, 20) || null)) {
    if ((await slotsDoCloser(cfg, c, busy[k], agora)).includes(inicio)) candidatos.push(k);
  }
  if (!candidatos.length) return json({ erro: "Esse horário acabou de ser ocupado. Escolha outro." }, 409);

  const { data: carga } = await sb.from("agenda_reservas").select("closer")
    .eq("status", "confirmado").gt("inicio", new Date(agora).toISOString());
  const conta = (k: string) => (carga ?? []).filter((r) => r.closer === k).length;
  candidatos.sort((a, b) => conta(a) - conta(b) || Math.random() - 0.5);

  const utm = d.utm && typeof d.utm === "object" ? d.utm as Record<string, unknown> : null;
  const respostas = d.respostas && typeof d.respostas === "object" ? d.respostas as Record<string, unknown> : null;
  const notas = limpa(d.notas, 1500);
  const origem = limpa(d.origem, 300);

  let reserva: { id: string } | null = null;
  let chave = "";
  for (const k of candidatos) {
    const { data, error } = await sb.from("agenda_reservas").insert({
      closer: k, calendar_id: cfg.closers[k].calendar_id,
      inicio: new Date(inicio).toISOString(), fim: new Date(fim).toISOString(),
      nome, email, whatsapp, instagram: instagram || null, notas: notas || null,
      respostas, origem: origem || null, utm,
    }).select("id").single();
    if (!error && data) { reserva = data; chave = k; break; }
    if (error && error.code !== "23505") throw error;
  }
  if (!reserva) return json({ erro: "Esse horário acabou de ser ocupado. Escolha outro." }, 409);

  const closer = cfg.closers[chave];
  const titulo = cfg.titulo_evento.replace("{nome}", nome);
  const dadosLead = [
    `Nome: ${nome}`, `WhatsApp: +${whatsapp}`, `E-mail: ${email}`,
    instagram ? `Instagram: ${instagram}` : "",
    ...Object.entries(respostas ?? {}).map(([p, r]) => `${p}: ${String(r).slice(0, 300)}`),
    notas ? `Observações: ${notas}` : "",
  ].filter(Boolean);
  const descricao = `Reunião com ${closer.nome}, do time da Reino.\n` +
    `Entre pelo link do Google Meet deste convite no horário marcado.\n\n` +
    `— Dados do agendamento —\n${dadosLead.join("\n")}`;
  const privado: Record<string, string> = { reserva_id: reserva.id, fonte: "agenda-reino" };
  if (origem) privado.origem = origem.slice(0, 200);
  for (const [k, v] of Object.entries(utm ?? {})) privado[k] = String(v).slice(0, 200);

  const criaEvento = async (url: string, corpo: unknown) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`${url} respondeu ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    if (!j.event_id) throw new Error(`${url} nao devolveu event_id`);
    return j as { event_id: string; meet_link?: string };
  };

  let evento: { event_id: string; meet_link?: string } | null = null;
  let convite = false;
  let podeFallback = true;
  if (cfg.n8n_evento_webhook) {
    try {
      evento = await criaEvento(cfg.n8n_evento_webhook, {
        token: cfg.n8n_token, closer: chave, calendar_id: closer.calendar_id_evento || "primary",
        evento: {
          summary: titulo,
          description: descricao,
          start: { dateTime: isoBRT(inicio), timeZone: "America/Sao_Paulo" },
          end: { dateTime: isoBRT(fim), timeZone: "America/Sao_Paulo" },
          attendees: [{ email, displayName: nome }],
          guestsCanModify: false,
          guestsCanInviteOthers: false,
          reminders: { useDefault: true },
          extendedProperties: { private: privado },
          conferenceData: { createRequest: { requestId: "agenda-" + reserva.id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
        },
      });
      convite = true;
    } catch (e) {
      podeFallback = !(e instanceof DOMException && e.name === "TimeoutError");
      console.error("evento com convite falhou", podeFallback ? "usando webhook antigo" : "(timeout)", e);
    }
  }
  if (!evento && podeFallback) {
    try {
      evento = await criaEvento(closer.webhook, {
        titulo, inicio: isoBRT(inicio), fim: isoBRT(fim),
        conversation_id: "site-" + reserva.id, descricao: "\n\n" + descricao,
      });
    } catch (e) {
      console.error("falha ao criar evento no Google", e);
      await sb.from("agenda_reservas").update({ status: "erro" }).eq("id", reserva.id);
      return json({ erro: "Não conseguimos confirmar agora. Tente de novo em instantes." }, 502);
    }
  }
  if (!evento) {
    await sb.from("agenda_reservas").update({ status: "erro" }).eq("id", reserva.id);
    return json({ erro: "Não conseguimos confirmar agora. Fale com a gente no WhatsApp." }, 502);
  }

  const meet = evento.meet_link || null;
  await sb.from("agenda_reservas").update({ event_id: evento.event_id, meet_link: meet }).eq("id", reserva.id);
  await sb.from("agenda_eventos").upsert({
    calendar_id: closer.calendar_id, closer: closer.nome, event_id: evento.event_id,
    titulo,
    inicio: new Date(inicio).toISOString(), fim: new Date(fim).toISOString(),
    meet_link: meet, status: "confirmed", all_day: false, atualizado_em: new Date().toISOString(),
  }, { onConflict: "calendar_id,event_id" });

  const { data: dataTxt, hora } = diaBRT(inicio);
  const [, mm, dd] = dataTxt.split("-");
  const aviso = [
    "📅 *NOVA REUNIÃO AGENDADA* (agenda do site)",
    "",
    `🗓️ ${dd}/${mm} às ${hora} — com ${closer.nome}`,
    `👤 ${nome}`,
    `📱 +${whatsapp}`,
    `✉️ ${email}`,
    ...(instagram ? [`📸 ${instagram}`] : []),
    ...Object.entries(respostas ?? {}).map(([p, r]) => `• ${p}: ${String(r).slice(0, 200)}`),
    ...(meet ? ["", `🎥 ${meet}`] : []),
    "",
    `Chamar: https://wa.me/${whatsapp}`,
  ].join("\n");

  const agendado = {
    estado: "agendou",
    funil: limpa(d.evento, 60) || "agenda-site",
    qualificado: true,
    answers: { nome, email, whatsapp, countryCode: "+55", instagram, ...(respostas ?? {}) },
    utm,
    agenda_inicio: isoBRT(inicio),
    agenda_link: meet,
    reserva_id: reserva.id,
    inicio: isoBRT(inicio),
    fim: isoBRT(fim),
    closer: closer.nome,
    closer_email: closer.calendar_id,
    event_id: evento.event_id,
    convite_enviado: convite,
    origem: origem || null,
  };

  const primeiro = nome.split(/\s+/)[0];
  const crisTexto = d.confirmar_lead === false ? "" : (cfg.cris_confirmacao || "")
    .replaceAll("{nome}", primeiro)
    .replaceAll("{dia}", SEMANA[new Date(inicio - 3 * 3600_000).getUTCDay()])
    .replaceAll("{data}", `${dd}/${mm}`)
    .replaceAll("{hora}", horaFalada(hora))
    .replaceAll("{closer}", closer.nome);

  const extras = await Promise.allSettled([
    moveCardAgendado({
      nome, email, whatsapp, instagram, funil: agendado.funil, utm, respostas,
      closer: closer.nome, inicio, meet, eventId: evento.event_id, origem, convId: convIdPedido,
    }).then((convId) => sb.from("agenda_reservas").update({ conversation_id: convId }).eq("id", reserva!.id)),
    ...(crisTexto && cfg.cris_webhook ? [postaComTimeout(cfg.cris_webhook, { number: whatsapp, text: crisTexto })] : []),
    postaComTimeout(cfg.aviso_webhook, { number: cfg.aviso_whatsapp, text: aviso }),
    ...(cfg.crm_webhook ? [postaComTimeout(cfg.crm_webhook, {
      nome, email, whatsapp: "+" + whatsapp, instagram, evento: agendado.funil,
      agendado_em: isoBRT(inicio), closer: closer.nome, meet_link: meet, ...(utm ?? {}),
    })] : []),
    ...(d.webhooks === false ? [] : cfg.webhooks_agendado ?? []).map((u) => postaComTimeout(u, agendado)),
  ]);
  extras.forEach((x) => x.status === "rejected" && console.error("pos-reserva falhou", x.reason));

  return json({
    ok: true,
    inicio: isoBRT(inicio),
    fim: isoBRT(fim),
    closer: closer.nome,
    meet_link: meet,
    convite_enviado: convite,
    titulo,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const acao = url.searchParams.get("acao");
  try {
    if (req.method === "GET" && acao === "slots") return await acaoSlots(url);
    if (req.method === "POST" && acao === "reservar") return await acaoReservar(req);
    return json({ erro: "acao invalida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: "Erro interno. Tente de novo em instantes." }, 500);
  }
});
