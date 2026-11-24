-- Entrega do 1º mês passa de 4 para 3 calls (decisão Mateus 24/11/2026):
--   1 Estratégia (Rafael) — monta o plano e já sobe o teste de temas
--   2 Criação de funil (Pedro) — analisa o resultado do teste e constrói o funil
--   3 Comercial (Thiago)
-- Toda call termina com a próxima agendada. Cada call tem um check do time
-- (entrega_call_itens, semeado por entrega_itens_modelo).
-- Seguro: em 24/11 nenhuma call 2-4 estava agendada/feita e nenhum entregável marcado.

create or replace function public.seed_entrega_calls(p_conv uuid)
returns void language plpgsql security definer as $$
begin
  insert into entrega_calls(conversation_id,ordem,titulo,responsavel,calendar_id) values
    (p_conv,1,'Estratégia','Rafael','mateus@digitalreino.com'),
    (p_conv,2,'Criação de funil','Pedro',null),
    (p_conv,3,'Comercial','Thiago','thiagocorporativo12@gmail.com')
  on conflict (conversation_id,ordem) do nothing;
end; $$;

create or replace function public.entrega_itens_modelo(p_ordem integer)
returns table(ordem integer, item text) language sql immutable as $$
  select m.ordem, m.item from (values
    (1,1,'Briefing lido antes da call'),
    (1,2,'Plano de ação apresentado e entregue'),
    (1,3,'Primeiros passos registrados com prazo (1 a 3)'),
    (1,4,'Temas do teste definidos com o cliente'),
    (1,5,'Criativos do teste de temas aprovados'),
    (1,6,'Teste de temas no ar'),
    (1,7,'Cliente avisado: o resultado do teste é analisado na próxima call'),
    (1,8,'Call 2 (Criação de funil) agendada'),
    (2,1,'Resultado do teste de temas analisado com o cliente'),
    (2,2,'Tema campeão definido'),
    (2,3,'Página com pixel, webhook e captura'),
    (2,4,'Banco de dados (Supabase) recebendo leads'),
    (2,5,'Automação rodando'),
    (2,6,'Campanha rodando'),
    (2,7,'Roteiro de novos criativos entregue'),
    (2,8,'Combinado: 5 criativos novos de vídeo por semana'),
    (2,9,'Call 3 (Comercial) agendada'),
    (3,1,'Resultado da campanha revisado com o cliente'),
    (3,2,'Scripts entregues (ligação, social selling, confirmação, call 1x1)'),
    (3,3,'Modelo de proposta entregue'),
    (3,4,'Rotina comercial combinada'),
    (3,5,'Plano comercial entregue'),
    (3,6,'Próximo acompanhamento agendado')
  ) m(call_ordem, ordem, item) where m.call_ordem = p_ordem
$$;

-- dados atuais: tira a call 4, renomeia 2 e 3, Rafael na call 1 ainda não marcada
delete from entrega_call_itens i using entrega_calls c
 where i.call_id = c.id and i.feito = false;
delete from entrega_calls where ordem = 4 and feita_em is null and inicio is null and coalesce(status,'pendente') = 'pendente';
update entrega_calls set titulo='Criação de funil', responsavel='Pedro', calendar_id=null where ordem = 2 and feita_em is null and inicio is null;
update entrega_calls set titulo='Comercial', responsavel='Thiago', calendar_id='thiagocorporativo12@gmail.com' where ordem = 3 and feita_em is null and inicio is null;
update entrega_calls set responsavel='Rafael' where ordem = 1 and feita_em is null and inicio is null and coalesce(status,'pendente') = 'pendente';
insert into entrega_call_itens(call_id, ordem, item)
select c.id, m.ordem, m.item from entrega_calls c, lateral entrega_itens_modelo(c.ordem) m
on conflict (call_id, ordem) do nothing;
