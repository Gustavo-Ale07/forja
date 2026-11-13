# Roteiro da semana

Legenda: `[x]` feito · `[~]` em andamento · `[!]` bloqueado (esperando você) · `[ ]` a fazer.
Regras: uma ação por passo de plano; nada específico de empresa em arquivo versionado; push só quando pedido; commit local a cada etapa.

## 1. Fase 2, etapa 6: auditoria no Postgres e TOTP na aprovação (feito)
- [x] Auditoria (`chamada_ferramenta`) no Postgres com `empresa_id` e `usuario_id`, só INSERT
- [x] Servidor MCP e calibrações gravando no banco (sai o SQLite)
- [x] `forja-auditoria` lendo do banco (empresa da sessão)
- [x] `forja-aprovar`: aprovador = usuário da sessão; código TOTP a cada assinatura e a cada `--passo`; mantém o HMAC
- [x] README atualizado

## 2. Fase 2, etapa 7: fechamento
- [x] README revisado e `.env.example` reduzido
- [!] Conferência final no sandbox: `consultar_sql` + `ler_dicionario` da AD_FORJATESTE — precisa reconectar o forja-sankhya com o build novo (você)

## 3. Catálogo de capacidades
- [ ] Estrutura `capacidades/<nome>/receita.md` + `casos/*.yaml`; `capacidades.local/` no `.gitignore`
- [ ] `pnpm forja-avaliar` (roda os casos)
- [ ] Capacidades, cada uma com ≥ 10 casos:
  - [ ] consultas com resposta visual (tabela, gráfico, exportar planilha)
  - [ ] dúvidas Sankhya
  - [ ] investigação de erros (só leitura, a partir do NUNOTA)
  - [ ] estrutura (tabela AD_, campo em AD_, campo adicional em tabela nativa)
  - [ ] telas
  - [ ] botões e ações
  - [ ] relatórios (criar/editar sempre com cópia versionada)
  - [ ] dashboards
  - [ ] personalizações
- [ ] Sementes genéricas: etiqueta de transporte pela nota faturada; agenda de tarefas em AD_; NCM/impostos em compra de uso e consumo; separação/conferência de pedidos em AD_; controle de acesso por perfis em AD_
- [ ] Leitura funcionando no sandbox; escrita nova marcada "em calibração"

## 3a. Reserva do passo antes de executar (feito)
- [x] Migração 004: resultado `em_execucao` e `reserva_id` (um desfecho por reserva, índice único)
- [x] Servidor reserva o passo no Postgres antes de mandar ao Sankhya; desfecho ligado à reserva
- [x] Reserva sem desfecho (queda ou trava de auditoria) recusa o passo mesmo depois de reiniciar; não repete
- [x] `forja-aprovar <id> --passo N --conferir feito|nao-feito` com TOTP fecha a reserva
- [!] Aplicar a migração 004 no banco `forja` (`pnpm db:migrar`) — junto com a reconexão do MCP (você)

## 4. Forja web mínima (Fase 3 enxuta)
- [ ] Next.js, direção visual "temperatura" (grafite, aço claro, verde-limão só para "agindo agora", Instrument Sans)
- [ ] Login com senha + TOTP
- [ ] Tela Trabalho: conversa + plano como folha lateral; Aprovar pede TOTP (aprovação passa a ser pela web)
- [ ] Pedidos e Auditoria
- [ ] Orquestrador com Claude Agent SDK usando o MCP forja-sankhya e o catálogo
- [ ] Captura de tela de cada passo no lugar do Sankhya ao vivo

## 5. Calibração supervisionada (para e chama você)
- [ ] Campo adicional em tabela nativa
- [ ] Botão que chama relatório com parâmetro
