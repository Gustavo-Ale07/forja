# Forja: Fase 1, servidor MCP do Sankhya (`packages/mcp-sankhya`)

Este servidor MCP dá ao Claude Code acesso **controlado** à base de **teste** do Sankhya.

- Leitura do dicionário e dos dados, pelo Gateway.
- Criação de tabelas e campos `AD_`, pelas telas oficiais (Playwright), com conferência por SELECT no dicionário.
- Gravação de registros com prévia, confirmação e aprovação.

Toda chamada passa por um **porteiro de 7 regras** e fica registrada numa **auditoria SQLite que só aceita INSERT**.

> Nesta fase **só existe o ambiente `teste`**. O servidor se recusa a iniciar se o config ou o `.env`
> apontar para algo que pareça produção. Ele também trava e encerra se `SELECT USER FROM DUAL` não
> devolver o usuário de banco esperado (`usuario_banco_esperado`).

## 1. Instalação

Requisitos: Node 24 e pnpm 11.

```powershell
cd C:\Dev\forja
pnpm install
pnpm --filter @forja/mcp-sankhya exec playwright install chromium
pnpm build
pnpm test        # porteiro, trava de produção, auditoria e executor (com Gateway falso)
```

## 2. Preencher o `.env`

### Configuração da sua base: `forja.config.local.yaml`

O `forja.config.yaml` versionado é genérico. Crie `forja.config.local.yaml` na raiz (está no `.gitignore`) com os valores reais da sua base de teste. O servidor lê esse arquivo por cima do genérico (objetos mesclados campo a campo; listas substituídas), e a trava de produção vale para o resultado:

```yaml
ambientes:
  teste:
    host_permitido: minha-empresa-teste.sankhyacloud.com.br
    usuario_banco_esperado: MEU_USUARIO_BANCO_TESTE
usuarios:
  meu_usuario: desenvolvedor
```

### `.env`

Copie `.env.example` para `.env`, na raiz do repositório. O `.env` está no `.gitignore` e o Claude Code está proibido de lê-lo (`.claude/settings.json`).

| Variável | O que é |
|---|---|
| `FORJA_USUARIO` | Seu usuário na seção `usuarios` da configuração. Exemplo: `seu_usuario`. |
| `FORJA_TESTE_URL` | Ex.: `https://SUA-BASE-TESTE.sankhyacloud.com.br`. Precisa ser o mesmo host de `host_permitido`. |
| `FORJA_TESTE_USUARIO` / `FORJA_TESTE_SENHA` | Login das telas do Sankhya de teste. Só o navegador usa. |
| `FORJA_TESTE_GATEWAY_CLIENT_ID` / `_CLIENT_SECRET` | Credencial `client_credentials` do Gateway, **da base de teste**. |
| `FORJA_TESTE_GATEWAY_TOKEN` | O `X-Token` do Gateway. |
| `FORJA_CHAVE_APROVACAO` | Chave da assinatura dos planos, com no mínimo 32 caracteres. Para gerar: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `FORJA_NAVEGADOR_VISIVEL=1` | Opcional. Mostra o navegador enquanto ele cria tabelas e campos. |
| `FORJA_LOG` | Opcional. Nível do log no stderr: `info` (padrão) ou `debug`. |

O modelo nunca recebe credencial: quem autentica é o servidor. Senha, token e segredo aparecem mascarados nos logs, nos erros e na auditoria.

**Nada fixo no código:**
- o host e o usuário de banco esperados vêm do `forja.config.yaml`;
- os perfis, os níveis de ação e as regras da empresa (horário, limite, tabelas bloqueadas) também.

## 3. Registrar no Claude Code

```powershell
cd C:\Dev\forja
claude mcp add forja-sankhya -- node packages/mcp-sankhya/dist/index.js
```

## 4. Como se trabalha (planos e aprovação)

| Ferramenta | Nível (perfil `desenvolvedor`) | Observação |
|---|---|---|
| `ler_dicionario`, `consultar_sql`, `carregar_registros` | livre, sem plano | `consultar_sql`: só SELECT ou WITH, até 1000 linhas, 30 s. TSI* bloqueada. Sem UNION/INTERSECT/MINUS, sem `*` dentro de subconsulta/CTE/função (só no SELECT de fora ou em `COUNT(*)`), sem funções XML/JSON/CURSOR que serializam linhas: a máscara de colunas sensíveis é pelo nome da coluna. |
| `propor_plano` | livre | O modelo grava `planos/<id>.json` **sem assinatura**. |
| `criar_tabela_ad` | livre | Exige um passo de plano **assinado**. Cria **só a tabela e a chave primária** (com auto numeração). |
| `criar_campo_ad` | livre | Exige um passo de plano **assinado**. Um passo por campo. **Só cria a coluna** (tipo, descrição, apresentação), sem opções e sem "Requerido". Seguro para repetir: se o campo já existe com o mesmo tipo, registra "já existia" e não mexe; com tipo diferente, recusa. |
| `definir_opcoes_lista` | livre | Exige um passo **assinado**; só em `AD_`. Inclui na lista as opções que faltam (botão "Opções") e confere em TDDOPC. Seguro para repetir: opções já iguais = "já existia"; mesmo valor com outra descrição = recusa. Não remove opções. |
| `marcar_obrigatorio` | livre | Exige um passo **assinado**; só em `AD_`. Liga "Requerido" (botão "Atributos") e confere em TDDPCO (`requerido = S`). Seguro para repetir: se já é requerido, "já existia". |
| `gravar_registros` | com_aprovacao | Exige um passo assinado **e aprovado** com `--passo`. A 1ª chamada devolve uma prévia e um código; só a 2ª grava. |

Uma ação por passo. Tabela nova = um passo `criar_tabela_ad` seguido de um passo `criar_campo_ad` por campo; as opções de um campo `lista` vão num passo `definir_opcoes_lista` e o "Requerido" num passo `marcar_obrigatorio`. O `propor_plano` recusa `campos` dentro de `criar_tabela_ad` e `opcoes`/`obrigatorio` dentro de `criar_campo_ad`. Exemplo de passos:

```json
[
  { "ferramenta": "criar_tabela_ad", "parametros": { "nome": "AD_FORJATESTE", "descricao": "Teste Forja" } },
  { "ferramenta": "criar_campo_ad", "parametros": { "tabela": "AD_FORJATESTE", "campo": "DESCRICAO", "descricao": "Descrição", "tipo": "texto" } },
  { "ferramenta": "criar_campo_ad", "parametros": { "tabela": "AD_FORJATESTE", "campo": "SITUACAO", "descricao": "Situação", "tipo": "lista" } },
  { "ferramenta": "definir_opcoes_lista", "parametros": { "tabela": "AD_FORJATESTE", "campo": "SITUACAO", "opcoes": [{ "valor": "A", "descricao": "Ativo" }, { "valor": "I", "descricao": "Inativo" }] } },
  { "ferramenta": "marcar_obrigatorio", "parametros": { "tabela": "AD_FORJATESTE", "campo": "DESCRICAO" } }
]
```

Se um passo falhar, os anteriores continuam valendo; corrija e rode de novo só o que faltou (o que já foi feito responde "já existia").

Fluxo:
1. O modelo chama `propor_plano`.
2. **Você** revisa `planos/<id>.json` e roda, no seu terminal:

```powershell
pnpm forja-aprovar <id>              # assina o plano (livre = pode executar)
pnpm forja-aprovar <id> --passo 2    # aprova um passo com_aprovacao
```

O comando pede que você digite o id de novo para confirmar. Ele só roda num terminal interativo e o Claude Code está proibido de chamá-lo. Cada passo executa **uma vez**: a auditoria é a fonte de verdade, e duas chamadas simultâneas do mesmo passo são barradas (a segunda é recusada na regra 2 com "já está em execução").

Qualquer mudança no plano depois da assinatura invalida o HMAC, e o porteiro recusa.

### Porteiro: as 7 regras, nesta ordem (para no primeiro "não")
1. Usuário e perfil.
2. Plano aprovado (HMAC-SHA256).
3. Ambiente.
4. Nível da ação.
5. Travas fixas:
   - estrutura só em `AD_`;
   - nada em TSI*;
   - nada fiscal ou financeiro, incluindo TGFTOP;
   - nada de DELETE nem de UPDATE sem filtro.
6. Regras da empresa: horário, limite de registros, tabelas fora do alcance.
7. Parâmetros: zod e parser de SQL.

Quando o porteiro recusa, nada é enviado ao Sankhya e a tentativa fica na auditoria com o motivo.

## 5. Ler a auditoria

```powershell
pnpm forja-auditoria               # eventos de hoje (fuso America/Sao_Paulo)
pnpm forja-auditoria 2026-11-13    # outro dia
pnpm forja-auditoria hoje --json   # JSON completo (antes_json, depois_json, captura_path)
```

Detalhes da auditoria:
- O banco fica em `auditoria/forja.db`, com a tabela `chamada_ferramenta`. UPDATE e DELETE são recusados por gatilho.
- As capturas de tela de cada passo ficam em `auditoria/capturas/`.
- Para abrir no DB Browser for SQLite ou no `sqlite3`: `SELECT * FROM chamada_ferramenta ORDER BY id DESC`.

## 6. Limites conhecidos da Fase 1

- **As regras de deny do `.claude/settings.json` não impedem por completo que o agente leia o `.env`.**
  - Elas bloqueiam as ferramentas Read, Edit e Write e os comandos listados.
  - Um comando indireto, como `node -e "…fs.readFileSync('.env')…"`, um script ou outro interpretador, não casa com essas regras.
  - Isso vale também para `FORJA_CHAVE_APROVACAO`: quem lê a chave consegue assinar um plano sozinho.
  - Na Fase 1, a garantia real é você revisar os comandos que o Claude Code pede para rodar.
- **A proteção definitiva da chave de aprovação vem quando a aprovação sair para a interface web.**
  - A chave vai ficar só no servidor de aprovação, fora da máquina e do alcance do agente.
  - A assinatura passa a exigir login do aprovador.
