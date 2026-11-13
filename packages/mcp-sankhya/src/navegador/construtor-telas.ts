import type { FrameLocator, Locator, Page } from 'playwright';
import { erroNavegador, ForjaErro } from '../comum/erros.js';
import { TIPOS_CAMPO } from '../sankhya/tipos-campo.js';
import { abrirCombo, clicarOpcao, escolherCombo } from './combo.js';
import { ESPERA_SALVAR_MS, SELETORES } from './seletores.js';
import type { SessaoNavegador } from './sessao.js';
import type { AlvoCampo, Capturador, Construtor, EspecCampo, EspecOpcoes, EspecTabela } from './tipos.js';

const S = SELETORES.construtor;
const ESPERA_TELA_MS = 30_000;

/** Um passo do assistente: esperar a tela abrir → agir → capturar → avançar. */
interface Passo {
  /** Espera o marcador da tela deste passo (a captura só sai depois disso). */
  tela?: () => Promise<void>;
  /** Preenche/escolhe o que é deste passo. */
  acao?: () => Promise<void>;
  /** Sai da tela (Próximo, Concluir...). Roda depois da captura. */
  avancar?: () => Promise<void>;
}

/**
 * Construtor de Telas do Sankhya via Playwright (fluxo da skill sankhya-estrutura-dados).
 * Calibrado até o formulário da chave primária do assistente "Nova Tela" (ver seletores.ts).
 * Cada passo captura a SUA tela já aberta e preenchida; se falhar, captura o estado e lança
 * ForjaErro com `capturaPath` (sem repassar a mensagem do Playwright).
 */
export class ConstrutorTelas implements Construtor {
  constructor(private readonly sessao: SessaoNavegador) {}

  private async passo(p: Page, cap: Capturador, nome: string, o: Passo): Promise<void> {
    let fase = 'tela';
    try {
      if (o.tela) await o.tela();
      this.sessao.garantirHost();
      fase = 'acao';
      if (o.acao) await o.acao();
      fase = 'captura';
      await cap.salvar(nome, await p.screenshot({ fullPage: true }));
      fase = 'avancar';
      if (o.avancar) await o.avancar();
      this.sessao.garantirHost();
    } catch (e) {
      await cap.salvar(`${nome}-FALHOU`, await p.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)));
      throw erroNavegador(e, nome, `(${fase}) do Construtor de Telas`, { fase, capturaPath: cap.pasta });
    }
  }

  private frame(p: Page): FrameLocator {
    return p.frameLocator(S.iframe);
  }

  private async abrirConstrutor(p: Page): Promise<void> {
    await this.sessao.abrirTela(p, 'Construtor de Telas');
    await this.frame(p).locator(S.aplicar).first().waitFor({ timeout: 60_000 });
  }

  /** Campo de texto pelo rótulo visível (label → input logo depois). */
  private campo(f: FrameLocator, rotulo: string): Locator {
    return f
      .locator(`label:has-text("${rotulo}")`)
      .filter({ visible: true })
      .last()
      .locator('xpath=following::*[self::input or self::textarea][not(@type="hidden")][1]');
  }

  private botao(f: FrameLocator, texto: string): Locator {
    return f.getByRole('button', { name: texto, exact: true }).filter({ visible: true }).last();
  }

  private visivel(f: FrameLocator, texto: string): Locator {
    return f.getByText(texto, { exact: false }).filter({ visible: true }).first();
  }

  /** Formulário de um registro aberto (abas Campos/Ligações visíveis), não a lista. */
  private async emRegistro(f: FrameLocator): Promise<boolean> {
    return f.getByText(S.abaLigacoes, { exact: true }).filter({ visible: true }).first().isVisible();
  }

  /**
   * O registro aberto é o da tabela? No formulário, "Nome da Tabela" e "Nome da Instância" trazem o
   * nome (somente leitura); o filtro da esquerda também pode trazer, por isso exige campo somente
   * leitura com o nome, ou ao menos dois campos visíveis com ele.
   */
  private async registroAberto(f: FrameLocator, tabela: string): Promise<boolean> {
    if (!(await this.emRegistro(f))) return false;
    return f.locator('input').evaluateAll((els, t) => {
      const vis = (els as HTMLInputElement[]).filter((el) => el.offsetParent !== null && el.value.trim().toUpperCase() === t);
      return vis.some((el) => el.readOnly || el.disabled) || vis.length >= 2;
    }, tabela.toUpperCase());
  }

  private async esperarHabilitado(l: Locator, timeout: number): Promise<void> {
    const fim = Date.now() + timeout;
    while (!(await l.isEnabled().catch(() => false))) {
      if (Date.now() > fim) throw new Error('botão continuou desabilitado');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async criarTabela(e: EspecTabela, cap: Capturador): Promise<void> {
    const p = await this.sessao.abrir();
    const f = this.frame(p);

    await this.passo(p, cap, '01-construtor', {
      tela: () => this.abrirConstrutor(p),
      avancar: async () => {
        await f.locator(S.botaoNovaTela).first().click();
        const ns = f.getByText(S.novaSolucao, { exact: true }).filter({ visible: true }).first();
        const tm = this.visivel(f, S.tipoTelaMestre);
        await ns.or(tm).first().waitFor({ timeout: ESPERA_TELA_MS });
        if (await ns.isVisible()) await ns.click();
      },
    });

    await this.passo(p, cap, '02-tipo-tela-mestre', {
      tela: () => this.visivel(f, S.tipoTelaMestre).waitFor({ timeout: ESPERA_TELA_MS }),
      acao: () => this.visivel(f, S.tipoTelaMestre).click(),
      avancar: () => this.botao(f, S.proximo).click(),
    });

    await this.passo(p, cap, '03-descricao-e-nome', {
      tela: () =>
        f.locator(`label:has-text("${S.rotuloNomeTabela}")`).filter({ visible: true }).first().waitFor({ timeout: ESPERA_TELA_MS }),
      acao: async () => {
        await this.campo(f, S.rotuloDescricaoInstancia).fill(e.descricao);
        // O Sankhya põe AD_ sozinho; digitar "_" faz ele sumir.
        await this.campo(f, S.rotuloNomeTabela).fill(e.nome.replace(/^AD_/, ''));
      },
      avancar: () => this.botao(f, S.proximo).click(),
    });

    await this.passo(p, cap, '04-chave-primaria', {
      tela: () => this.visivel(f, S.marcadorChavePrimaria).waitFor({ timeout: ESPERA_TELA_MS }),
      acao: async () => {
        // A grade da PK abre vazia: o "+" dela abre o formulário da linha.
        await f.locator(S.adicionarLinhaPk).filter({ visible: true }).first().click();
        await this.campo(f, S.rotuloNomeCampo).fill(e.pk.nome);
        await this.campo(f, S.rotuloDescricaoCampo).fill(e.pk.descricao);
        await escolherCombo(f, S.rotuloTipoCampo, 'Número Inteiro');
        await escolherCombo(f, S.rotuloApresentacao, 'Padrão');
      },
    });

    await this.passo(p, cap, '05-chave-primaria-salva', {
      // ✓ "Salvar [F7]" da linha (em memória no assistente; só o Concluir cria a tabela).
      acao: async () => {
        await f.locator(S.salvarLinhaPk).filter({ visible: true }).first().click();
        await this.esperarHabilitado(this.botao(f, S.proximo), ESPERA_TELA_MS);
      },
      avancar: () => this.botao(f, S.proximo).click(),
    });

    await this.passo(p, cap, '06-auto-numeracao', {
      tela: () => this.visivel(f, S.marcadorAutoNumeracao).waitFor({ timeout: ESPERA_TELA_MS }),
      acao: async () => {
        const opcoes = await abrirCombo(f, S.rotuloAutoNumeracao);
        const pk = e.pk.nome.toUpperCase();
        const alvo =
          opcoes.find((o) => o.toUpperCase() === pk) ??
          opcoes.find((o) => new RegExp(`^${pk}\\b`).test(o.toUpperCase())) ??
          opcoes.find((o) => o === e.pk.descricao);
        if (!alvo) throw new ForjaErro('NAVEGADOR_PASSO', `Auto numeração: campo ${e.pk.nome} não está entre as opções (${opcoes.join(', ')}).`);
        await clicarOpcao(f, alvo);
      },
      avancar: async () => {
        await this.botao(f, S.concluir).click();
        await this.visivel(f, S.marcadorAutoNumeracao).waitFor({ state: 'hidden', timeout: ESPERA_SALVAR_MS });
      },
    });

    await this.passo(p, cap, '07-concluido', {
      tela: () => p.waitForLoadState('networkidle', { timeout: ESPERA_SALVAR_MS }),
    });
  }

  /**
   * Abre o registro da tabela (reaproveita se já aberto) e a aba Campos. Recusa se houver edição
   * pendente na aba (botão "Descartar" visível): nada é mexido.
   */
  private async abrirAbaCampos(p: Page, f: FrameLocator, tabela: string): Promise<void> {
    if (!(await this.registroAberto(f, tabela))) {
      await this.abrirConstrutor(p);
      if (!(await this.registroAberto(f, tabela))) {
        await f.locator(S.filtroTabela).fill(tabela);
        await f.locator(S.aplicar).first().click();
        // Na lista: duplo clique na linha. No formulário: o filtro já traz o registro.
        const linha = f.getByText(tabela, { exact: true }).filter({ visible: true }).first();
        const fim = Date.now() + ESPERA_TELA_MS;
        while (!(await this.registroAberto(f, tabela))) {
          if (Date.now() > fim) throw new ForjaErro('NAVEGADOR_PASSO', `O registro ${tabela} não abriu no Construtor de Telas.`);
          if (!(await this.emRegistro(f)) && (await linha.isVisible())) await linha.dblclick();
          await p.waitForTimeout(500);
        }
      }
    }
    await f.getByText(S.abaCampos, { exact: true }).filter({ visible: true }).first().click({ timeout: ESPERA_TELA_MS });
    await f.locator(S.botaoNovoCampo).waitFor({ timeout: ESPERA_TELA_MS });
    if (await this.botao(f, S.descartar).isVisible()) {
      throw new ForjaErro('NAVEGADOR_PASSO', `Há uma edição pendente na aba Campos de ${tabela}; nada foi mexido.`);
    }
  }

  /** Valor de "Nome do campo" no formulário da aba Campos ('' quando a aba está em grade). */
  private nomeCampoMostrado(f: FrameLocator): Promise<string> {
    return f
      .locator(`label:has-text("${S.rotuloNomeCampo}")`)
      .filter({ visible: true })
      .last()
      .locator('xpath=following::input[not(@type="hidden")][1]')
      .inputValue({ timeout: 5_000 })
      .then((v) => v.trim().toUpperCase())
      .catch(() => '');
  }

  /**
   * Deixa o formulário do campo `campo` aberto na aba Campos. A aba abre em grade (calibrado):
   * duplo clique na linha. Se já estiver em formulário de outro campo, navega com Primeiro/Próximo.
   */
  private async abrirCampo(p: Page, f: FrameLocator, campo: string): Promise<void> {
    const alvo = campo.toUpperCase();
    if ((await this.nomeCampoMostrado(f)) === alvo) return;
    const celula = f.getByText(alvo, { exact: true }).filter({ visible: true }).last();
    if (await celula.isVisible().catch(() => false)) {
      await celula.dblclick();
      await p.waitForTimeout(1_000);
    }
    if ((await this.nomeCampoMostrado(f)) !== alvo) {
      const primeiro = f.locator(`${S.botaoPrimeiro}:not([disabled])`).filter({ visible: true }).last();
      if (await primeiro.count()) await primeiro.click();
      const proximo = f.locator(`${S.botaoProximo}:not([disabled])`).filter({ visible: true }).last();
      for (let i = 0; i < 200 && (await this.nomeCampoMostrado(f)) !== alvo && (await proximo.count()); i++) {
        await proximo.click();
        await p.waitForTimeout(400);
      }
    }
    const mostrado = await this.nomeCampoMostrado(f);
    if (mostrado !== alvo) {
      throw new ForjaErro('NAVEGADOR_PASSO', `O campo ${alvo} não foi encontrado na aba Campos (formulário mostra "${mostrado}").`);
    }
  }

  private janela(f: FrameLocator): Locator {
    return f.locator(S.janela).filter({ visible: true }).last();
  }

  private entradaNaJanela(f: FrameLocator, rotulo: RegExp): Locator {
    return this.janela(f)
      .locator('label, span.lblText')
      .filter({ hasText: rotulo })
      .filter({ visible: true })
      .first()
      .locator('xpath=following::*[self::input or self::textarea][not(@type="hidden")][1]');
  }

  /** OK do rodapé da janela; espera ela fechar e a rede assentar (grava no dicionário). */
  private async confirmarJanela(p: Page, f: FrameLocator): Promise<void> {
    const janela = this.janela(f);
    await janela.locator(S.okJanela).filter({ visible: true }).last().click();
    await janela.waitFor({ state: 'hidden', timeout: ESPERA_SALVAR_MS });
    await p.waitForLoadState('networkidle', { timeout: ESPERA_SALVAR_MS });
  }

  async criarCampo(e: EspecCampo, cap: Capturador): Promise<void> {
    const p = await this.sessao.abrir();
    const def = TIPOS_CAMPO[e.tipo];
    const f = this.frame(p);

    await this.passo(p, cap, `abrir-${e.tabela}`, {
      tela: () => this.abrirAbaCampos(p, f, e.tabela),
      avancar: () => f.locator(S.botaoNovoCampo).click(),
    });

    await this.passo(p, cap, `campo-${e.campo}-formulario`, {
      tela: () => this.campo(f, S.rotuloNomeCampo).waitFor({ timeout: ESPERA_TELA_MS }),
      acao: async () => {
        await this.campo(f, S.rotuloNomeCampo).fill(e.campo);
        await this.campo(f, S.rotuloDescricaoCampo).fill(e.descricao);
        await escolherCombo(f, S.rotuloTipoCampo, e.tipo === 'lista' ? 'Texto' : def.rotulo);
        await escolherCombo(f, S.rotuloApresentacao, SELETORES.apresentacao[e.tipo]);
      },
      avancar: () => f.locator(S.salvarCampo).filter({ visible: true }).first().click(),
    });

    // Salvar leva 15–20 s (ALTER TABLE): o formulário sai do modo edição ("Descartar" some) quando gravou.
    await this.passo(p, cap, `campo-${e.campo}-salvo`, {
      tela: async () => {
        await this.botao(f, S.descartar).waitFor({ state: 'hidden', timeout: ESPERA_SALVAR_MS });
        await p.waitForLoadState('networkidle', { timeout: ESPERA_SALVAR_MS });
      },
    });
  }

  async incluirOpcoes(e: EspecOpcoes, cap: Capturador): Promise<void> {
    const p = await this.sessao.abrir();
    const f = this.frame(p);

    await this.passo(p, cap, `opcoes-${e.campo}-campo`, {
      tela: async () => {
        await this.abrirAbaCampos(p, f, e.tabela);
        await this.abrirCampo(p, f, e.campo);
      },
      avancar: async () => {
        await this.botao(f, S.botaoOpcoesTexto).click();
        await this.janela(f).locator(S.novaLinhaJanela).filter({ visible: true }).first().waitFor({ timeout: ESPERA_TELA_MS });
      },
    });

    for (const o of e.opcoes) {
      await this.passo(p, cap, `opcoes-${e.campo}-linha-${o.valor}`, {
        tela: async () => {
          await this.janela(f).locator(S.novaLinhaJanela).filter({ visible: true }).first().click();
          await this.entradaNaJanela(f, S.rotuloValorOpcao).waitFor({ timeout: ESPERA_TELA_MS });
        },
        acao: async () => {
          await this.entradaNaJanela(f, S.rotuloValorOpcao).fill(o.valor);
          await this.entradaNaJanela(f, S.rotuloDescricaoOpcao).fill(o.descricao);
        },
        // ✓ "Salvar [F7]" da linha; a janela sai do modo edição ("Descartar" some).
        avancar: async () => {
          const janela = this.janela(f);
          await janela.locator(S.salvarLinhaJanela).filter({ visible: true }).first().click();
          await janela.getByRole('button', { name: S.descartar, exact: true }).waitFor({ state: 'hidden', timeout: ESPERA_SALVAR_MS });
        },
      });
    }

    await this.passo(p, cap, `opcoes-${e.campo}-linhas-salvas`, {
      avancar: () => this.confirmarJanela(p, f),
    });
    await this.passo(p, cap, `opcoes-${e.campo}-ok`, {});
  }

  async marcarRequerido(e: AlvoCampo, cap: Capturador): Promise<void> {
    const p = await this.sessao.abrir();
    const f = this.frame(p);
    const interruptor = () => this.janela(f).locator(S.interruptorRequerido).filter({ visible: true }).first();
    const ligado = () => interruptor().locator('input[type="checkbox"]').isChecked();

    await this.passo(p, cap, `requerido-${e.campo}-campo`, {
      tela: async () => {
        await this.abrirAbaCampos(p, f, e.tabela);
        await this.abrirCampo(p, f, e.campo);
      },
      avancar: async () => {
        await this.botao(f, S.botaoAtributosTexto).click();
        await interruptor().waitFor({ timeout: ESPERA_TELA_MS });
      },
    });

    await this.passo(p, cap, `requerido-${e.campo}-ligado`, {
      acao: async () => {
        if (!(await ligado())) await interruptor().locator('span.sk-container').click();
        if (!(await ligado())) throw new ForjaErro('NAVEGADOR_PASSO', 'O interruptor "Requerido" não ligou.');
      },
      avancar: () => this.confirmarJanela(p, f),
    });
    await this.passo(p, cap, `requerido-${e.campo}-ok`, {});
  }

  async fechar(): Promise<void> {
    await this.sessao.fechar();
  }
}
