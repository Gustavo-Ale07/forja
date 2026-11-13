# Forja: servidor MCP do Sankhya (`packages/mcp-sankhya`)

Este servidor MCP dá ao Claude Code acesso **controlado** à base de **teste** do Sankhya.

- Leitura do dicionário e dos dados, pelo Gateway.
- Criação de tabelas e campos `AD_`, pelas telas oficiais (Playwright), com conferência por SELECT no dicionário.
- Gravação de registros com prévia, confirmação e aprovação.

Toda chamada passa por um **porteiro de 7 regras** e fica registrada numa **auditoria no Postgres que só aceita INSERT**. Usuários, perfis, regras da empresa e credenciais (cifradas) também ficam no Postgres; cada pessoa entra com senha + código TOTP.

> Nesta fase **só existe o ambiente `teste`**. O servidor se recusa a iniciar se a configuração
> apontar para algo que pareça produção. Ele também trava e encerra se `SELECT USER FROM DUAL` não
> devolver o usuário de banco esperado.

## 1. Instalação

Requisitos: Node 24, pnpm 11 e Docker.

```powershell
cd C:\Dev\forja
pnpm install
pnpm --filter @forja/mcp-sankhya exec playwright install chromium
pnpm build
pnpm db:subir    # Postgres local em 127.0.0.1:55433 (bancos forja e forja_teste)
pnpm db:migrar   # aplica as migrações no banco forja
pnpm test        # porteiro, trava de produção, banco (RLS, login, auditoria) e executor (Gateway falso)
```

## 2. Configurar

### `.env`

Copie `.env.example` para `.env`, na raiz do repositório. O `.env` está no `.gitignore` e o Claude Code está proibido de lê-lo (`.claude/settings.json`).

| Variável | Quem usa | O que é |
|---|---|---|
| `FORJA_DATABASE_URL` | servidor, `forja-aprovar`, `forja-auditoria`, login | Postgres com o papel `forja_app` (sujeito ao RLS). |
| `FORJA_DATABASE_URL_ADMIN` | `db:migrar`, `forja-admin` | Postgres com o papel `forja_dono` (migrações e cadastros). |
| `FORJA_CHAVE_MESTRA` | servidor, `forja-admin`, `forja-aprovar` | 32 bytes em hex (64 caracteres) que cifram e decifram as credenciais e o TOTP no banco. |
| `FORJA_CHAVE_APROVACAO` | servidor, `forja-aprovar` | Chave do HMAC dos planos, com no mínimo 32 caracteres. |
| `FORJA_TESTE_URL` e `FORJA_TESTE_*` | só `importar-config` | URL da base de teste (mesmo host de `host_permitido`) e, se quiser, as 5 credenciais. Depois de importar, podem sair do `.env`. |
| `FORJA_NAVEGADOR_VISIVEL=1` | servidor | Opcional. Mostra o navegador enquanto ele cria tabelas e campos. |
| `FORJA_LOG` | servidor | Opcional. Nível do log no stderr: `info` (padrão) ou `debug`. |

Para gerar as duas chaves: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

As senhas do Postgres local são padrões de desenvolvimento (veja `docker-compose.yml`); para trocá-las, defina `FORJA_PG_SENHA_*` no `.env` **antes** da primeira subida do volume.

### Empresa, usuário e base de teste (no banco)

Perfis, níveis de ação e regras saem do `forja.config.yaml` versionado (genérico). Os valores da sua base ficam em `forja.config.local.yaml` (está no `.gitignore`), lido por cima do genérico (objetos mesclados campo a campo; listas substituídas):

```yaml
ambientes:
  teste:
    host_permitido: minha-empresa-teste.sankhyacloud.com.br
    usuario_banco_esperado: MEU_USUARIO_BANCO_TESTE
usuarios:
  meu_usuario: desenvolvedor
```

Depois, rode no seu terminal (o `forja-admin` pergunta senha e código TOTP; não cole nada disso no chat):

```powershell
pnpm forja-admin empresa criar --slug minha-empresa --nome "Minha Empresa"
pnpm forja-admin importar-config --empresa minha-empresa   # ambiente teste, perfis, regras e usuários
pnpm forja-admin usuario ativar --login meu_usuario        # senha + TOTP do usuário importado
pnpm forja-admin ambiente cadastrar --empresa minha-empresa --url https://minha-empresa-teste.sankhyacloud.com.br --usuario-banco MEU_USUARIO_BANCO_TESTE
pnpm forja-admin ambiente testar --empresa minha-empresa
```

- O `ambiente cadastrar` só é preciso se as credenciais não vieram pelo `importar-config` (variáveis `FORJA_TESTE_*` vazias): ele pergunta as 5 credenciais do Sankhya de teste (login e senha das telas, `client_id`, `client_secret` e `X-Token` do Gateway) e grava cifrado.
- O `ambiente testar` confere a trava de produção, as credenciais e o `SELECT USER` pelo Gateway.
- Outros usuários: `pnpm forja-admin usuario criar --empresa minha-empresa --login L --nome "N" --perfil P`.

O modelo nunca recebe credencial: quem autentica é o servidor. Senha, token e segredo aparecem mascarados nos logs, nos erros e na auditoria. Host e usuário de banco esperados, perfis, níveis de ação e regras da empresa (horário, limite, tabelas bloqueadas) vêm do banco, não do código.

## 3. Entrar e registrar no Claude Code

O servidor só sobe com uma sessão válida. Antes de iniciar o Claude Code, rode **no seu terminal**:

```powershell
pnpm forja-admin login     # pede login, senha e o código TOTP do aplicativo
pnpm forja-admin logout    # encerra a sessão no banco e apaga o arquivo local
```

Registro (uma vez):

```powershell
cd C:\Dev\forja
claude mcp add forja-sankhya -- node packages/mcp-sankhya/dist/index.js
```

Depois de um `login` novo, reconecte o servidor no Claude Code (`/mcp`).

- A sessão vale 12 horas. O banco guarda só o hash do token.
- O arquivo da sessão fica **fora do repositório**: `%APPDATA%\forja\sessao` no Windows e `~/.config/forja/sessao` (ou `$XDG_CONFIG_HOME/forja/sessao`) no resto. O `login` mostra o caminho exato.
- A cada chamada de ferramenta, o servidor confere de novo a sessão e relê as permissões no banco:
  - logout, expiração e troca de senha ou TOTP derrubam a próxima chamada (regra 1);
  - mudar o perfil de alguém vale na hora, sem reiniciar.
- Trocar de empresa exige reiniciar o servidor MCP.

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

O comando exige a sessão da Forja (`pnpm forja-admin login`): **o aprovador é o usuário dessa sessão**, gravado em `aprovado_por`. Ele mostra o plano, pede que você digite o id de novo e pede **um código TOTP novo do aplicativo autenticador a cada assinatura e a cada `--passo`**. O código é conferido e consumido no banco: o mesmo código não serve duas vezes. Código errado = nada é gravado, e a recusa fica na auditoria. Ele só roda num terminal interativo e o Claude Code está proibido de chamá-lo. Cada passo executa **uma vez**: a auditoria é a fonte de verdade, e duas chamadas simultâneas do mesmo passo são barradas (a segunda é recusada na regra 2 com "já está em execução").

Qualquer mudança no plano depois da assinatura invalida o HMAC, e o porteiro recusa. Plano assinado por quem não é mais usuário ativo da empresa também é recusado (regra 2); aprove de novo.

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
- Fica no Postgres, na tabela `chamada_ferramenta`, separada por empresa (RLS) e com o usuário da sessão. O papel `forja_app` só tem SELECT e INSERT; UPDATE, DELETE e TRUNCATE são recusados por gatilho.
- Entram as chamadas do servidor MCP, as calibrações e as aprovações e recusas do `forja-aprovar`.
- O `forja-auditoria` exige a sessão e lista só a empresa dela, no fuso da empresa.
- As capturas de tela de cada passo ficam em `auditoria/capturas/`.
- O arquivo SQLite da Fase 1 (`auditoria/forja.db`), se existir, não é mais usado nem apagado: fica como histórico.

## 6. Limites conhecidos

- **O `forja-aprovar` pede um código TOTP a cada assinatura e a cada `--passo`.**
  - Pelo caminho oficial, ninguém aprova sem o aplicativo autenticador.
  - Mas o porteiro confere o HMAC, não o TOTP: quem conseguir ler a `FORJA_CHAVE_APROVACAO` ainda consegue montar uma assinatura válida sem passar pelo comando. Isso só acaba quando a aprovação for para a web (a chave sai desta máquina).
- **As regras de deny do `.claude/settings.json` não impedem por completo que o agente leia o `.env` ou a sessão.**
  - Elas bloqueiam as ferramentas Read, Edit e Write e os comandos listados.
  - Um comando indireto, como `node -e "…fs.readFileSync('.env')…"`, um script ou outro interpretador, não casa com essas regras.
  - A garantia real, por enquanto, é você revisar os comandos que o Claude Code pede para rodar.
- **A separação completa só vem quando o servidor rodar fora desta máquina.** Hoje a `FORJA_CHAVE_MESTRA` e o `.env` ficam na mesma máquina em que o agente roda.
- **Se a ação rodar no Sankhya e a gravação da auditoria falhar** (ex.: Postgres fora do ar), o servidor trava com "TRAVA DE AUDITORIA" e não roda mais nada, nem repete o passo. Essa trava vale só até reiniciar: antes de reiniciar, confira no Sankhya se o passo foi feito, porque a auditoria não tem o registro dele.
