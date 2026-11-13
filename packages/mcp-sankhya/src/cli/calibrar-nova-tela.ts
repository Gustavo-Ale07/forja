#!/usr/bin/env node
/**
 * forja-calibrar-nova-tela — calibração SUPERVISIONADA do assistente "Nova Tela" do Construtor de Telas.
 *
 * Percorre: "+" → Nova Solução → Tela mestre → descrição/nome → chave primária (preenche, abre o combo
 * "Apresentação", escolhe "Padrão", confirma a linha) → tela seguinte (auto numeração) → CANCELAR.
 *
 * Nunca clica em Concluir, Salvar, Excluir, lixeira, fechar ou "X": todo clique passa por `clicar`,
 * que recusa esses elementos. Mesmo em erro, tenta sair pelo "Cancelar" do assistente.
 * Cada tela gera <nn>-<etapa>.png + .json (elementos visíveis do iframe) em auditoria/capturas/calibracao-*.
 * Registra um evento na auditoria. Só roda na base de teste (mesma trava de produção do servidor).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import { AuditoriaPostgres } from '../auditoria/registro.js';
import { erroNavegador, ForjaErro } from '../comum/erros.js';
import { mensagemSegura } from '../comum/mascara.js';
import { carregarConfigBanco } from '../config/banco.js';
import { abrirCombo, linhasCombo, valorCombo } from '../navegador/combo.js';
import { SELETORES } from '../navegador/seletores.js';
import { SessaoNavegador } from '../navegador/sessao.js';
import { cliqueProibido, dumpNoNavegador } from './calibracao-comum.js';

process.env.TZ ??= 'America/Sao_Paulo';

const S = SELETORES.construtor;
/** Mesmos dados do passo 1 do plano forjateste. */
const DADOS = { descricao: 'Teste Forja', nomeSemPrefixo: 'FORJATESTE', pkNome: 'ID', pkDescricao: 'Código' };
/** O Sankhya escreve "Apresentacão" (com c). */
const ROTULO_APRESENTACAO = /^\s*Apresenta[cç][aã]o:?\s*$/i;
const ROTULO_TIPO = /^\s*Tipo de dados:?\s*$/i;

interface Registro {
  etapa: string;
  png: string;
  json: string;
  dialogoAberto: boolean;
  popups: Array<{ cls: string | null; itens: string[] }>;
}

async function principal(): Promise<void> {
  const cfg = await carregarConfigBanco();
  const pasta = path.join(cfg.caminhos.capturas, `calibracao-nova-tela-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(pasta, { recursive: true });
  const sessao = new SessaoNavegador({
    url: cfg.credenciais.url,
    hostPermitido: cfg.configAmbiente.host_permitido,
    usuario: cfg.credenciais.usuario,
    senha: cfg.credenciais.senha,
    visivel: cfg.navegadorVisivel,
  });
  const registros: Registro[] = [];
  const cliques: string[] = [];
  const achados: Record<string, unknown> = {};
  let p: Page | undefined;
  let erro: string | undefined;
  /** Último passo iniciado (registro de tela ou clique): nomeia a falha na auditoria. */
  let passoAtual = 'abrir-construtor';
  /** A auditoria recebe a mesma mensagem segura das ferramentas; o detalhe técnico só no terminal. */
  const falha = (e: unknown): string => {
    process.stdout.write(`  detalhe técnico (não vai para a auditoria): ${mensagemSegura(e)}
`);
    return mensagemSegura(erroNavegador(e, passoAtual, 'da calibração do assistente Nova Tela'));
  };

  const frame = (pg: Page): Frame => {
    const fr = pg.frames().find((x) => x.url().includes('CadastroTelasAdicionais'));
    if (!fr) throw new ForjaErro('NAVEGADOR_PASSO', 'iframe do Construtor de Telas não encontrado.');
    return fr;
  };
  const registrar = async (etapa: string): Promise<Registro> => {
    passoAtual = etapa;
    const n = String(registros.length + 1).padStart(2, '0');
    const base = path.join(pasta, `${n}-${etapa}`);
    await fs.writeFile(`${base}.png`, await p!.screenshot({ fullPage: true }));
    const d = (await frame(p!).evaluate(dumpNoNavegador)) as { dialogoAberto: boolean; itens: unknown[]; popups: Registro['popups']; html: string };
    await fs.writeFile(`${base}.json`, JSON.stringify({ etapa, dialogoAberto: d.dialogoAberto, popups: d.popups, itens: d.itens }, null, 1));
    if (d.html) await fs.writeFile(`${base}.html`, d.html);
    const r = { etapa, png: `${base}.png`, json: `${base}.json`, dialogoAberto: d.dialogoAberto, popups: d.popups };
    registros.push(r);
    process.stdout.write(`  [${n}] ${etapa} (diálogo aberto: ${d.dialogoAberto})\n`);
    return r;
  };
  /** Único jeito de clicar: recusa qualquer coisa que salve, exclua ou feche. */
  const clicar = async (l: Locator, rotulo: string): Promise<void> => {
    passoAtual = rotulo;
    await l.waitFor({ state: 'visible', timeout: 30_000 });
    const desc = await l.evaluate((el) =>
      [el.textContent ?? '', el.getAttribute('title') ?? '', el.getAttribute('tooltip') ?? '', el.getAttribute('aria-label') ?? '', el.querySelector('[class*="glyphicons-"]')?.getAttribute('class') ?? ''].join(' | '),
    );
    if (cliqueProibido(desc.split(' | '))) throw new ForjaErro('CLIQUE_PROIBIDO', `clique recusado pela calibração em "${rotulo}" (${desc.replace(/\s+/g, ' ').slice(0, 120)})`);
    cliques.push(`${rotulo} ⇒ ${desc.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
    await l.click({ timeout: 15_000 });
    await p!.waitForTimeout(1_500);
  };
  const campo = (f: FrameLocator, rotulo: string): Locator =>
    f.locator(`label:has-text("${rotulo}")`).filter({ visible: true }).last().locator('xpath=following::*[self::input or self::textarea][not(@type="hidden")][1]');
  const botao = (f: FrameLocator, texto: string): Locator => f.getByRole('button', { name: texto, exact: true }).filter({ visible: true }).last();

  const cancelarAssistente = async (f: FrameLocator): Promise<void> => {
    const c = botao(f, 'Cancelar');
    if (!(await c.count())) return;
    await clicar(c, 'Cancelar (assistente)');
    await registrar('apos-cancelar');
    // Se o Sankhya pedir confirmação do cancelamento, só aceita se o texto falar em cancelar/descartar.
    const confirma = f.getByRole('button', { name: /^(Sim|OK)$/ }).filter({ visible: true }).last();
    if (await confirma.count()) {
      const texto = await f.locator('.modal, [role="dialog"]').filter({ visible: true }).last().textContent().catch(() => '');
      if (/cancel|descart|perder/i.test(texto ?? '')) {
        await clicar(confirma, 'Confirmar cancelamento');
        await registrar('cancelamento-confirmado');
      }
    }
  };

  let f: FrameLocator | undefined;
  try {
    process.stdout.write(`Calibração do assistente Nova Tela (base de TESTE). Capturas: ${pasta}\n`);
    p = await sessao.abrir();
    f = p.frameLocator(S.iframe);
    await sessao.abrirTela(p, 'Construtor de Telas');
    await f.locator(S.aplicar).first().waitFor({ timeout: 60_000 });
    sessao.garantirHost();
    await registrar('construtor-aberto');

    await clicar(f.locator(S.botaoNovaTela).first(), '+ (Adicionar nova tela)');
    await registrar('apos-mais');
    const ns = f.getByText(S.novaSolucao, { exact: true }).filter({ visible: true }).first();
    if (await ns.count()) {
      await clicar(ns, 'Nova Solução');
    }
    await f.getByText(S.tipoTelaMestre, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await registrar('tela-tipo');

    await clicar(f.getByText(S.tipoTelaMestre, { exact: false }).filter({ visible: true }).first(), 'Tela mestre');
    await registrar('tipo-tela-mestre-marcado');
    await clicar(botao(f, S.proximo), 'Próximo (tipo)');
    await f.locator(`label:has-text("${S.rotuloNomeTabela}")`).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await registrar('tela-descricao-e-nome');

    await campo(f, S.rotuloDescricaoInstancia).fill(DADOS.descricao);
    await campo(f, S.rotuloNomeTabela).fill(DADOS.nomeSemPrefixo);
    await registrar('descricao-e-nome-preenchidos');
    await clicar(botao(f, S.proximo), 'Próximo (descrição e nome)');
    await f.getByText('Informe a chave primária', { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await registrar('tela-chave-primaria');

    // A grade da PK abre vazia: o "+" dela (tooltip "Cadastrar Descrição de Campos [F8]") abre o formulário.
    await clicar(f.locator('.modal button.btn-novo-registro').filter({ visible: true }).first(), '+ (grade da chave primária)');
    await registrar('chave-primaria-formulario');
    await campo(f, S.rotuloNomeCampo).fill(DADOS.pkNome);
    await campo(f, S.rotuloDescricaoCampo).fill(DADOS.pkDescricao);
    // Combos são sk-combobox (ui-select): abrir pelo .selectize-input e clicar na linha.
    achados.tipoDadosOpcoes = await abrirCombo(f, ROTULO_TIPO);
    await registrar('tipo-dados-opcoes');
    await linhasCombo(f).filter({ hasText: /^\s*Número Inteiro\s*$/ }).first().click();
    cliques.push('combo Tipo de dados ⇒ Número Inteiro');
    await p.waitForTimeout(1_000);
    achados.tipoDadosEscolhido = await valorCombo(f, ROTULO_TIPO);
    // Apresentação: o que o Sankhya põe sozinho ao escolher o tipo, e a lista completa.
    achados.apresentacaoAntes = await valorCombo(f, ROTULO_APRESENTACAO);
    achados.apresentacaoOpcoes = await abrirCombo(f, ROTULO_APRESENTACAO);
    await registrar('apresentacao-opcoes');
    await linhasCombo(f).filter({ hasText: /^\s*Padrão\s*$/ }).first().click();
    cliques.push('combo Apresentação ⇒ Padrão');
    await p.waitForTimeout(1_000);
    achados.apresentacaoEscolhida = await valorCombo(f, ROTULO_APRESENTACAO);
    await registrar('chave-primaria-preenchida');

    // O ✓ desta barra é "Salvar [F7]": NÃO é clicado (o pedido proíbe qualquer clique que salve).
    achados.botaoConfirmarLinha = await f
      .locator('.modal button:has(span.glyphicons-ok-2)')
      .filter({ visible: true })
      .first()
      .getAttribute('tooltip')
      .catch(() => null);
    achados.proximoHabilitadoSemSalvarLinha = await botao(f, S.proximo).isEnabled();
    achados.concluirHabilitado = await botao(f, S.concluir).isEnabled();
  } catch (e) {
    erro = falha(e);
    process.stdout.write(`  ERRO na calibração: ${erro}\n`);
    if (p) await registrar('FALHOU').catch(() => undefined);
  } finally {
    if (p && f) {
      try {
        await cancelarAssistente(f);
        if (await f.getByText('Nova Tela', { exact: true }).filter({ visible: true }).count()) {
          await p.keyboard.press('Escape').catch(() => undefined);
          await p.waitForTimeout(1_000);
        }
        const aindaAberto = await f.getByText('Nova Tela', { exact: true }).filter({ visible: true }).count();
        achados.assistenteFechado = aindaAberto === 0;
        await registrar('final');
      } catch (e) {
        erro = `${erro ? `${erro}; ` : ''}cancelamento: ${falha(e)}`;
      }
    }
    await sessao.fechar();
  }

  const resumo = { pasta, erro, achados, cliques, etapas: registros.map((r) => path.basename(r.png)) };
  await fs.writeFile(path.join(pasta, 'resumo.json'), JSON.stringify(resumo, null, 2));
  const aud = new AuditoriaPostgres(cfg.app, cfg.empresaId);
  try {
    await aud.registrar({
      usuarioId: cfg.usuarioId,
      usuario: cfg.login,
      perfil: cfg.arquivo.usuarios[cfg.login],
      ambiente: cfg.ambiente,
      ferramenta: 'calibracao_nova_tela',
      parametros: { dados: DADOS, cliques },
      resultado: erro ? 'erro' : 'aceito',
      motivo: erro ?? 'calibração supervisionada concluída e assistente cancelado (sem Concluir)',
      capturaPath: pasta,
    });
  } finally {
    await cfg.app.destroy();
  }
  process.stdout.write(`${JSON.stringify(resumo, null, 2)}\n`);
  if (erro) process.exitCode = 1;
}

principal().catch((e: unknown) => {
  process.stderr.write(`forja-calibrar-nova-tela: ${mensagemSegura(e)}\n`);
  process.exit(1);
});
