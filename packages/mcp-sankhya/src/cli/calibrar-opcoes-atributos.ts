#!/usr/bin/env node
/**
 * forja-calibrar-opcoes-atributos — calibração SUPERVISIONADA das janelas "Opções" e "Atributos"
 * de um campo já existente no Construtor de Telas (por padrão AD_FORJATESTE.SITUACAO).
 *
 * Percorre: abrir o registro → aba Campos → ir até o campo → "Opções" → "+" → preencher uma linha
 * (valor/descrição, sem confirmar) → CANCELAR → "Atributos" → localizar "Requerido" → CANCELAR.
 *
 * Nunca clica em OK, ✓, Confirmar, Salvar, Concluir, Excluir, lixeira, fechar ou "X": todo clique
 * passa por `clicar`, que recusa esses elementos. Ao fim o navegador é fechado sem gravar nada.
 * Cada tela gera <nn>-<etapa>.png + .json (+ .html da janela aberta) em auditoria/capturas/calibracao-*.
 * Registra um evento na auditoria. Só roda na base de teste (mesma trava de produção do servidor).
 *
 * Uso: node packages/mcp-sankhya/dist/cli/calibrar-opcoes-atributos.js [TABELA] [CAMPO]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import { AuditoriaPostgres } from '../auditoria/registro.js';
import { erroNavegador, ForjaErro } from '../comum/erros.js';
import { mensagemSegura } from '../comum/mascara.js';
import { carregarConfigBanco } from '../config/banco.js';
import { SELETORES } from '../navegador/seletores.js';
import { SessaoNavegador } from '../navegador/sessao.js';
import { cliqueProibido, dumpNoNavegador } from './calibracao-comum.js';

process.env.TZ ??= 'America/Sao_Paulo';

const S = SELETORES.construtor;
const TABELA = (process.argv[2] ?? 'AD_FORJATESTE').toUpperCase();
const CAMPO = (process.argv[3] ?? 'SITUACAO').toUpperCase();
/** Linha de exemplo digitada (e descartada) na janela Opções. */
const LINHA = { valor: 'A', descricao: 'Ativo' };
/** Além do proibido comum: nada que confirme ou grave a janela. */
const PROIBIDO_JANELA = /^ok$|glyphicons-(ok|check)|confirm|salvar ordem|aplicar/i;

interface Registro {
  etapa: string;
  png: string;
  dialogoAberto: boolean;
}

async function principal(): Promise<void> {
  const cfg = await carregarConfigBanco();
  const pasta = path.join(cfg.caminhos.capturas, `calibracao-opcoes-atributos-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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
  let passoAtual = 'abrir-construtor';
  const falha = (e: unknown): string => {
    process.stdout.write(`  detalhe técnico (não vai para a auditoria): ${mensagemSegura(e)}\n`);
    return mensagemSegura(erroNavegador(e, passoAtual, 'da calibração das janelas Opções/Atributos'));
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
    const d = (await frame(p!).evaluate(dumpNoNavegador)) as { dialogoAberto: boolean; itens: unknown[]; popups: unknown[]; html: string };
    await fs.writeFile(`${base}.json`, JSON.stringify({ etapa, dialogoAberto: d.dialogoAberto, popups: d.popups, itens: d.itens }, null, 1));
    if (d.html) await fs.writeFile(`${base}.html`, d.html);
    const r = { etapa, png: `${base}.png`, dialogoAberto: d.dialogoAberto };
    registros.push(r);
    process.stdout.write(`  [${n}] ${etapa} (diálogo aberto: ${d.dialogoAberto})\n`);
    return r;
  };
  /** Único jeito de clicar. `janela` = dentro de Opções/Atributos (regras mais duras). */
  const clicar = async (l: Locator, rotulo: string, janela = false): Promise<void> => {
    passoAtual = rotulo;
    await l.waitFor({ state: 'visible', timeout: 30_000 });
    const partes = await l.evaluate((el) => [
      el.textContent ?? '',
      el.getAttribute('title') ?? '',
      el.getAttribute('tooltip') ?? '',
      el.getAttribute('aria-label') ?? '',
      el.querySelector('[class*="glyphicons-"]')?.getAttribute('class') ?? '',
    ]);
    const desc = partes.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    if (cliqueProibido(partes, janela ? PROIBIDO_JANELA : undefined)) {
      throw new ForjaErro('CLIQUE_PROIBIDO', `clique recusado pela calibração em "${rotulo}" (${desc.slice(0, 120)})`);
    }
    cliques.push(`${rotulo} ⇒ ${desc.slice(0, 100)}`);
    await l.click({ timeout: 15_000 });
    await p!.waitForTimeout(1_500);
  };
  const janela = (f: FrameLocator): Locator => f.locator('.modal').filter({ visible: true }).last();
  /** Botões visíveis da janela aberta, com texto/tooltip/ícone (para mapear sem clicar). */
  const botoesDaJanela = (f: FrameLocator): Promise<unknown[]> =>
    janela(f)
      .locator('button')
      .evaluateAll((els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => ({
            txt: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
            tooltip: el.getAttribute('tooltip') ?? el.getAttribute('title'),
            icone: el.querySelector('[class*="glyphicons-"]')?.getAttribute('class') ?? null,
            cls: el.getAttribute('class'),
            desabilitado: (el as HTMLButtonElement).disabled,
          })),
      );
  const valorNomeCampo = (f: FrameLocator): Promise<string> =>
    f
      .locator(`label:has-text("${S.rotuloNomeCampo}")`)
      .filter({ visible: true })
      .last()
      .locator('xpath=following::input[not(@type="hidden")][1]')
      .inputValue({ timeout: 10_000 })
      .catch(() => '');

  /** Sai da janela pelo "Cancelar"; se o Sankhya pedir confirmação de descarte, aceita só essa. */
  const cancelarJanela = async (f: FrameLocator, nome: string): Promise<void> => {
    await clicar(janela(f).getByRole('button', { name: 'Cancelar', exact: true }).filter({ visible: true }).last(), `Cancelar (${nome})`, true);
    const pergunta = f.locator('.modal').filter({ visible: true }).filter({ hasText: /descart|perder|cancel/i }).last();
    if (await pergunta.count()) {
      const sim = pergunta.getByRole('button', { name: /^(Sim)$/ }).filter({ visible: true }).last();
      if (await sim.count()) {
        await registrar(`${nome}-pergunta-descartar`);
        await clicar(sim, `Sim, descartar (${nome})`);
      }
    }
    await registrar(`${nome}-cancelada`);
  };

  let f: FrameLocator | undefined;
  try {
    process.stdout.write(`Calibração das janelas Opções/Atributos em ${TABELA}.${CAMPO} (base de TESTE). Capturas: ${pasta}\n`);
    p = await sessao.abrir();
    f = p.frameLocator(S.iframe);
    await sessao.abrirTela(p, 'Construtor de Telas');
    await f.locator(S.aplicar).first().waitFor({ timeout: 60_000 });
    sessao.garantirHost();
    await registrar('construtor-aberto');

    // Abrir o registro da tabela: filtro → Aplicar → (lista) duplo clique na linha.
    await f.locator(S.filtroTabela).fill(TABELA);
    await clicar(f.locator(S.aplicar).first(), 'Aplicar (filtro)');
    const aba = f.getByText(S.abaLigacoes, { exact: true }).filter({ visible: true }).first();
    if (!(await aba.isVisible())) {
      const linha = f.getByText(TABELA, { exact: true }).filter({ visible: true }).first();
      await linha.dblclick({ timeout: 30_000 });
      cliques.push(`duplo clique na linha ${TABELA}`);
    }
    await aba.waitFor({ timeout: 30_000 });
    await clicar(f.getByText(S.abaCampos, { exact: true }).filter({ visible: true }).first(), 'aba Campos');
    await f.locator(S.botaoNovoCampo).waitFor({ timeout: 30_000 });
    await registrar('aba-campos');

    // Ir até o campo. A aba Campos pode abrir em grade (lista de campos) ou em formulário.
    achados.campoInicial = await valorNomeCampo(f);
    if (achados.campoInicial !== CAMPO) {
      const linhaGrade = f.getByText(CAMPO, { exact: true }).filter({ visible: true }).last();
      achados.abaCamposEmGrade = (await linhaGrade.count()) > 0 && achados.campoInicial === '';
      if (achados.abaCamposEmGrade) {
        await linhaGrade.dblclick({ timeout: 15_000 });
        cliques.push(`duplo clique na linha ${CAMPO} da grade de campos`);
        await p.waitForTimeout(1_500);
      }
      const proximo = f.locator('button[tooltip^="Próximo" i]:not([disabled])').filter({ visible: true });
      for (let i = 0; i < 10 && (await valorNomeCampo(f)) !== CAMPO && (await proximo.count()); i++) {
        await clicar(proximo.last(), 'Próximo (aba Campos)');
      }
    }
    achados.campoMostrado = await valorNomeCampo(f);
    await registrar('campo-mostrado');
    if (achados.campoMostrado !== CAMPO) throw new ForjaErro('NAVEGADOR_PASSO', `Não consegui mostrar o campo ${CAMPO} na aba Campos (mostrado: "${String(achados.campoMostrado)}").`);
    achados.edicaoPendenteAntes = await f.getByRole('button', { name: S.descartar, exact: true }).filter({ visible: true }).count();

    // ---- Janela Opções ----
    await clicar(f.getByRole('button', { name: 'Opções', exact: true }).filter({ visible: true }).last(), 'Opções');
    await janela(f).waitFor({ timeout: 30_000 });
    await registrar('opcoes-aberta');
    achados.opcoesBotoes = await botoesDaJanela(f);
    await clicar(janela(f).locator('button.btn-novo-registro').filter({ visible: true }).first(), '+ (Opções)', true);
    await registrar('opcoes-apos-mais');
    achados.opcoesBotoesAposMais = await botoesDaJanela(f);
    achados.opcoesEntradas = await janela(f)
      .locator('input:not([type="hidden"]), textarea')
      .evaluateAll((els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => {
            const sk = el.closest('sk-simple-item, td, .form-group');
            return {
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type'),
              ngModel: el.getAttribute('ng-model'),
              skField: el.closest('[sk-field]')?.getAttribute('sk-field') ?? null,
              rotulo: (sk?.querySelector('label, .lblText')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
              cls: el.getAttribute('class'),
            };
          }),
      );
    // Preenche a linha pelos rótulos, se existirem (só digita; não confirma).
    const entradaPorRotulo = (r: RegExp): Locator =>
      janela(f!).locator('label, span.lblText').filter({ hasText: r }).filter({ visible: true }).first().locator('xpath=following::*[self::input or self::textarea][not(@type="hidden")][1]');
    const valor = entradaPorRotulo(/^\s*Valor/i);
    const descricao = entradaPorRotulo(/^\s*(Op[cç][aã]o|Descri)/i);
    achados.rotuloValorEncontrado = (await valor.count()) > 0;
    achados.rotuloDescricaoEncontrado = (await descricao.count()) > 0;
    if (achados.rotuloValorEncontrado) await valor.fill(LINHA.valor);
    if (achados.rotuloDescricaoEncontrado) await descricao.fill(LINHA.descricao);
    await registrar('opcoes-linha-preenchida');
    await cancelarJanela(f, 'opcoes');
    achados.opcoesFechada = (await janela(f).count()) === 0;

    // ---- Janela Atributos ----
    await clicar(f.getByRole('button', { name: 'Atributos', exact: true }).filter({ visible: true }).last(), 'Atributos');
    await janela(f).waitFor({ timeout: 30_000 });
    await registrar('atributos-aberta');
    achados.atributosBotoes = await botoesDaJanela(f);
    achados.requerido = await janela(f)
      .getByText("Requerido", { exact: false })
      .filter({ visible: true })
      .evaluateAll((els) =>
        els.map((el) => {
          let c: Element | null = el;
          for (let i = 0; i < 3 && c?.parentElement; i++) c = c.parentElement;
          return { tag: el.tagName.toLowerCase(), txt: (el.textContent ?? '').trim().slice(0, 80), contexto: (c?.outerHTML ?? '').slice(0, 1500) };
        }),
      );
    await cancelarJanela(f, 'atributos');

    achados.edicaoPendenteDepois = await f.getByRole('button', { name: S.descartar, exact: true }).filter({ visible: true }).count();
    await registrar('final');
  } catch (e) {
    erro = falha(e);
    process.stdout.write(`  ERRO na calibração: ${erro}\n`);
    if (p) await registrar('FALHOU').catch(() => undefined);
    // Se uma janela ficou aberta, sai pelo Cancelar (nunca OK).
    if (f) {
      for (const nome of ['opcoes', 'atributos']) {
        if (await janela(f).count().catch(() => 0)) await cancelarJanela(f, `${nome}-apos-erro`).catch(() => undefined);
      }
    }
  } finally {
    // Fecha o navegador sem gravar nada (qualquer edição em aberto é perdida).
    await sessao.fechar();
  }

  const resumo = { pasta, tabela: TABELA, campo: CAMPO, erro, achados, cliques, etapas: registros.map((r) => path.basename(r.png)) };
  await fs.writeFile(path.join(pasta, 'resumo.json'), JSON.stringify(resumo, null, 2));
  const aud = new AuditoriaPostgres(cfg.app, cfg.empresaId);
  try {
    await aud.registrar({
      usuarioId: cfg.usuarioId,
      usuario: cfg.login,
      perfil: cfg.arquivo.usuarios[cfg.login],
      ambiente: cfg.ambiente,
      ferramenta: 'calibracao_opcoes_atributos',
      parametros: { tabela: TABELA, campo: CAMPO, linhaDigitada: LINHA, cliques },
      resultado: erro ? 'erro' : 'aceito',
      motivo: erro ?? 'calibração supervisionada concluída; janelas Opções e Atributos canceladas (sem OK/✓)',
      capturaPath: pasta,
    });
  } finally {
    await cfg.app.destroy();
  }
  process.stdout.write(`${JSON.stringify({ ...resumo, achados: { ...achados } }, null, 2)}\n`);
  if (erro) process.exitCode = 1;
}

principal().catch((e: unknown) => {
  process.stderr.write(`forja-calibrar-opcoes-atributos: ${mensagemSegura(e)}\n`);
  process.exit(1);
});
