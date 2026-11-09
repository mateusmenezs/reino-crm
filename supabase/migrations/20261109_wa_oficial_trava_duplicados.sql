-- WhatsApp Oficial: 1 contato e 1 conversa por número.
-- Contato/conversa do canal 'oficial' nascem com account_id NULL, então as travas existentes
-- (account_id, ig_user_id) e (account_id, contact_id) não seguravam: mensagens simultâneas de um
-- número novo criavam conversas duplicadas e a IA respondia várias vezes.

-- 1) Testes de 09/11 (número falso 5599000000002): arquiva as conversas e tira os 2 contatos
--    extras do caminho da trava (sem apagar nada).
update conversations set is_archived = true
 where channel = 'oficial'
   and contact_id in (select id from contacts where channel = 'oficial' and phone like '5599000000002%');

update contacts c set phone = c.phone || '-dup' || d.n, ig_user_id = c.ig_user_id || '-dup' || d.n
  from (select id, row_number() over (order by created_at, id) - 1 as n
          from contacts where channel = 'oficial' and phone = '5599000000002') d
 where c.id = d.id and d.n > 0;

-- 2) Travas
create unique index if not exists contacts_oficial_phone_uk
  on contacts (phone) where channel = 'oficial';
create unique index if not exists conversations_oficial_contact_uk
  on conversations (contact_id) where channel = 'oficial';
