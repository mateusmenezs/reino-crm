# 🚀 Deploy automático (GitHub → Cloudflare Pages) — Playbook da Reino

Cole o bloco **PROMPT** abaixo no início de **qualquer conversa nova** (bio, página de vendas, portal de membros, etc.) pra o Claude publicar o site com deploy automático, igual ao CRM.

Depois de montado, o fluxo é: **você/Claude edita → commit + push → Cloudflare publica sozinho.** Cada projeto = 1 repositório + 1 projeto no Cloudflare Pages (com sua própria URL `*.pages.dev`).

---

## 📋 PROMPT (copia e cola numa conversa nova)

> Quero publicar este projeto (site estático: HTML/CSS/JS) com **deploy automático via GitHub → Cloudflare Pages**, igual ao meu CRM. Faça assim:
>
> 1. **Crie o repositório** no GitHub em `mateusmenezs/<nome-do-projeto>` (privado) e **suba os arquivos**. Vou te passar um **GitHub Personal Access Token** (fine-grained, All repositories, permissões Contents + Administration = Read and write) — **me peça o token**. Com ele você consegue criar o repo e dar push.
> 2. **Pasta que vai pro ar:** me pergunte qual é a pasta de saída (a raiz do projeto, ou uma subpasta tipo `publicar/`). Crie um `.gitignore` pra não subir backups/node_modules.
> 3. **Me guie no passo único do painel do Cloudflare** (é OAuth, não dá por API): dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** → autorizar GitHub → escolher o repo → em **Build settings**: Framework preset = **None**, Build command = **(vazio)**, **Build output directory = `<pasta-de-saída>`** → **Save and Deploy**.
> 4. **Daqui em diante:** sempre que você alterar o projeto, faça o **commit + push** (o remote já tem o token) que o Cloudflare publica sozinho. Me dê a URL `*.pages.dev` no fim.
>
> **Dados fixos:** GitHub owner = `mateusmenezs`. Cloudflare = conta do Mateus (tenho um token Pages:Edit, te passo se precisar). Identidade visual = **V7** (skill `marca-reino-treinamentos`): vinho `#3B101D` + laranja `#FF4D00` + claro `#F5F3ED`, Anton nos títulos de apresentação + Manrope no resto.

---

## 🔑 Onde guardar os tokens (você, no seu gerenciador de senhas)

- **GitHub PAT** (fine-grained, All repos, Contents + Administration R/W) — reutilizável em todos os projetos. Validade 30–90 dias; quando expirar, gera outro igual.
- **Cloudflare API Token** (escopo *Cloudflare Pages: Edit*) — serve pro deploy por CLI (wrangler), caso algum dia a gente não use o git. No fluxo git, nem precisa.

> ⚠️ Nunca cole os tokens num arquivo público nem no próprio repo. Guarda no gerenciador de senhas e cola no chat só quando o Claude pedir.

---

## 🧠 Resumo do que já está montado

- **CRM:** repo `mateusmenezs/reino-crm` → Cloudflare Pages → **https://reino-crm.pages.dev** (output dir = `publicar`). Deploy automático ligado.
- Mesmo padrão se repete pra cada projeto novo.
