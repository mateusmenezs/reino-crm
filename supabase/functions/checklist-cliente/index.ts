import { createClient } from "jsr:@supabase/supabase-js@2";

// API da página de checklist do cliente (link pessoal #c=<conversation_id>).
// A definição do checklist (5 fases) mora no banco: função checklist_jornada().
// action 'get'   -> jornada completa (fases/itens) + campos legados (itens, calls, briefing_ok).
// action 'set'   -> cliente marca/desmarca um item do tipo 'cliente'.
// action 'passo' -> cliente marca/desmarca um primeiro passo do plano de ação.
// Usa service role injetada (nenhuma chave em código). O conversation_id (UUID)
// funciona como token do link; só responde se a conversa for cliente (produto != null).

// chaves antigas aceitas pra não quebrar páginas em cache
const LEGADO = new Set(["hospedagem", "anuncios", "n8n", "supabase", "evolution"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function jornada(db: any, c: string) {
  const { data, error } = await db.rpc("checklist_jornada", { p_conv: c });
  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const action = String(body?.action || "get");
  const c = String(body?.c || "").trim();
  if (!UUID.test(c)) return json({ error: "link_invalido" }, 400);

  const db = admin();
  let j: any;
  try { j = await jornada(db, c); } catch (e) { return json({ error: "falha", detail: String(e) }, 500); }
  if (!j) return json({ error: "cliente_nao_encontrado" }, 404);

  const todos: any[] = (j.fases || []).flatMap((f: any) => f.itens || []);
  const now = new Date().toISOString();

  if (action === "set") {
    const item = String(body?.item_key || "");
    const ok = todos.some((i) => i.key === item && i.tipo === "cliente") || LEGADO.has(item);
    if (!ok) return json({ error: "item_invalido" }, 400);
    const feito = !!body?.feito;
    const { error } = await db.from("checklist_cliente").upsert({
      conversation_id: c, item_key: item, feito,
      feito_em: feito ? now : null, feito_por: "cliente", atualizado_em: now,
    }, { onConflict: "conversation_id,item_key" });
    if (error) return json({ error: "save_falhou", detail: error.message }, 500);
    return json({ ok: true, item_key: item, feito });
  }

  if (action === "passo") {
    const id = String(body?.passo_id || "");
    if (!UUID.test(id)) return json({ error: "passo_invalido" }, 400);
    const feito = !!body?.feito;
    const { data, error } = await db.from("plano_acao_passos")
      .update({ feito_em: feito ? now : null, feito_por: feito ? "cliente" : null })
      .eq("id", id).eq("conversation_id", c).select("id");
    if (error) return json({ error: "save_falhou", detail: error.message }, 500);
    if (!data || !data.length) return json({ error: "passo_invalido" }, 404);
    return json({ ok: true, passo_id: id, feito });
  }

  // get — novo formato (jornada) + campos legados para a página antiga
  const itens: Record<string, boolean> = {};
  todos.filter((i) => i.tipo === "cliente").forEach((i) => { itens[i.key] = !!i.feito; });
  const calls = todos.filter((i) => i.tipo === "call").map((i) => ({
    ordem: i.ordem, titulo: i.label, responsavel: i.responsavel ?? null,
    feita: !!i.feito && i.status === "feita", status: i.status,
    inicio: i.inicio ?? null, tem_agenda: !!i.tem_agenda, meet_link: i.meet_link ?? null,
  }));
  const briefing_ok = !!todos.find((i) => i.key === "briefing")?.feito;

  return json({ ok: true, nome: j.nome, produto: j.produto, briefing_ok, itens, calls, jornada: j });
});
