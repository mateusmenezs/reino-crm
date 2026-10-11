# Reino CRM V6

Implementação visual do CRM V5 fornecido em 08/09/2026, com identidade oficial REINO V2.0 e arquitetura de navegação revisada. O original permanece preservado em `../reino-sistemas-ux/originais/reino-crm-v5-original.html`.

## Rodar

Use Node.js 22 ou posterior.

```sh
npm start
```

Abra `http://127.0.0.1:4188`. O frontend continua apontando para o projeto Supabase configurado no arquivo recebido. Nenhum esquema, registro, política, usuário ou integração externa foi alterado nesta entrega.

## O que mudou

- Identidade Blue Architecture, fontes locais, azul estrutural e latão fosco.
- Entrada em Visão comercial.
- Navegação priorizada: visão, tarefas, canais, pipeline, contatos e CS.
- Cartões, filtros, modais, estados e responsividade alinhados ao Manual V2.0.
- Bibliotecas essenciais hospedadas dentro do projeto; a interface não depende de CDN.
- Funções de negócio existentes preservadas.

## Bibliotecas fixadas

- React 18.3.1.
- ReactDOM 18.3.1.
- Supabase JS 2.112.0.

## Verificação e limite operacional

O carregamento, o formulário de login, o JavaScript e a responsividade foram testados em 1440 px e 390 px, sem estouro horizontal. As telas autenticadas têm referência navegável em `../reino-sistemas-ux/crm/index.html`.

Antes de substituir a versão em uso, execute homologação autenticada com um usuário de teste: leitura, criação, edição, exclusão, movimentação, mensagens, agenda, relatórios e permissões. A chave do navegador deve permanecer pública; nunca use `service_role` no frontend. As políticas RLS do Supabase continuam responsáveis pela autorização e precisam de auditoria própria.

## Estrutura

- `index.html`: CRM funcional preservado e restilizado.
- `ux-v2.css`: sistema visual e responsivo.
- `vendor/`: dependências fixadas localmente.
- `brand/`: logos e fontes oficiais.
- `previews/`: evidências desktop e mobile.
