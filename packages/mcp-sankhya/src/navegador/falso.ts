import type { BaseFalsa } from '../gateway/falso.js';
import type { AlvoCampo, Capturador, Construtor, EspecCampo, EspecOpcoes, EspecTabela } from './tipos.js';

/** PNG 1x1 transparente: captura "de mentira" do construtor falso. */
const PNG_VAZIO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Construtor de Telas falso: cria na BaseFalsa o que o Sankhya criaria. */
export class ConstrutorFalso implements Construtor {
  readonly acoes: string[] = [];
  /** Simula divergência: a tela "salva" mas o campo não aparece no dicionário. */
  naoCriarCampo = false;
  /** Simula divergência: a janela "confirma" mas nada chega a TDDOPC/TDDPCO. */
  naoGravarJanela = false;
  /** Simula falha do navegador num passo do assistente (erro cru, como o do Playwright). */
  falharTabela = false;

  constructor(private readonly base: BaseFalsa) {}

  async criarTabela(e: EspecTabela, cap: Capturador): Promise<void> {
    this.acoes.push(`criarTabela ${e.nome}`);
    await cap.salvar('nova-solucao', PNG_VAZIO);
    if (this.falharTabela) {
      await cap.salvar('chave-primaria-FALHOU', PNG_VAZIO);
      throw new Error('locator.click: Timeout 30000ms exceeded');
    }
    this.base.criarTabela(e.nome, e.descricao, e.pk.nome);
    await cap.salvar('concluido', PNG_VAZIO);
  }

  async criarCampo(e: EspecCampo, cap: Capturador): Promise<void> {
    this.acoes.push(`criarCampo ${e.tabela}.${e.campo}`);
    await cap.salvar(`campo-${e.campo}-formulario`, PNG_VAZIO);
    if (!this.naoCriarCampo) this.base.criarCampo(e.tabela, e.campo, e.descricao, e.tipo);
    await cap.salvar(`campo-${e.campo}-salvo`, PNG_VAZIO);
  }

  async incluirOpcoes(e: EspecOpcoes, cap: Capturador): Promise<void> {
    this.acoes.push(`incluirOpcoes ${e.tabela}.${e.campo} ${e.opcoes.map((o) => o.valor).join(',')}`);
    await cap.salvar(`opcoes-${e.campo}-campo`, PNG_VAZIO);
    if (!this.naoGravarJanela) this.base.incluirOpcoes(e.tabela, e.campo, e.opcoes);
    await cap.salvar(`opcoes-${e.campo}-ok`, PNG_VAZIO);
  }

  async marcarRequerido(e: AlvoCampo, cap: Capturador): Promise<void> {
    this.acoes.push(`marcarRequerido ${e.tabela}.${e.campo}`);
    await cap.salvar(`requerido-${e.campo}-campo`, PNG_VAZIO);
    if (!this.naoGravarJanela) this.base.marcarRequerido(e.tabela, e.campo);
    await cap.salvar(`requerido-${e.campo}-ok`, PNG_VAZIO);
  }

  async fechar(): Promise<void> {}
}
