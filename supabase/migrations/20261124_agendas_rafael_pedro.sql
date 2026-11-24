-- Agendas próprias de Rafael (Call 1) e Pedro (Call 2), compartilhadas com mateus@digitalreino.com (24/11/2026).
-- O Sync Agenda (n8n Tgou06qiqQYtSbmx) passa a ler as 4 agendas; aqui cada call aponta para a agenda do responsável.
create or replace function public.seed_entrega_calls(p_conv uuid)
returns void language plpgsql security definer as $$
begin
  insert into entrega_calls(conversation_id,ordem,titulo,responsavel,calendar_id) values
    (p_conv,1,'Estratégia','Rafael','contato.rafaellimads@gmail.com'),
    (p_conv,2,'Criação de funil','Pedro','pedrohsarcanjoo@gmail.com'),
    (p_conv,3,'Comercial','Thiago','thiagocorporativo12@gmail.com')
  on conflict (conversation_id,ordem) do nothing;
end; $$;

-- calls ainda não agendadas passam para a agenda do responsável (as 25 calls 1 já marcadas com o Mateus ficam como estão)
update entrega_calls set calendar_id = 'contato.rafaellimads@gmail.com'
 where ordem = 1 and responsavel = 'Rafael' and inicio is null and feita_em is null and coalesce(status,'pendente') = 'pendente';
update entrega_calls set calendar_id = 'pedrohsarcanjoo@gmail.com'
 where ordem = 2 and inicio is null and feita_em is null and coalesce(status,'pendente') = 'pendente';
