import type { TipoCampo } from '../sankhya/tipos-campo.js';

/** Salva uma captura de tela por passo do navegador. */
export interface Capturador {
  /** Pasta da chamada (vai para captura_path na auditoria). */
  readonly pasta: string;
  readonly arquivos: string[];
  salvar(passo: string, png: Buffer): Promise<string>;
}

export interface EspecTabela {
  /** Nome completo (AD_XXX). A tela recebe só o que vem depois de AD_. */
  nome: string;
  descricao: string;
  pk: { nome: string; descricao: string };
}

export interface EspecCampo {
  /** Tabela completa (AD_XXX). */
  tabela: string;
  /** Nome sem AD_, como digitado na tela. */
  campo: string;
  descricao: string;
  tipo: TipoCampo;
}

export interface Opcao {
  valor: string;
  descricao: string;
}

/** Campo já existente (nome real da coluna, como aparece na grade da aba Campos). */
export interface AlvoCampo {
  tabela: string;
  campo: string;
}

export interface EspecOpcoes extends AlvoCampo {
  /** Só as opções que FALTAM (as que já existem não são digitadas de novo). */
  opcoes: Opcao[];
}

/** Quem cria estrutura pelas telas oficiais do Sankhya (Construtor de Telas). */
export interface Construtor {
  criarTabela(espec: EspecTabela, cap: Capturador, signal?: AbortSignal): Promise<void>;
  criarCampo(espec: EspecCampo, cap: Capturador, signal?: AbortSignal): Promise<void>;
  /** Botão "Opções" do campo: inclui as linhas e confirma com OK. */
  incluirOpcoes(espec: EspecOpcoes, cap: Capturador, signal?: AbortSignal): Promise<void>;
  /** Botão "Atributos" do campo: liga "Requerido" e confirma com OK. */
  marcarRequerido(alvo: AlvoCampo, cap: Capturador, signal?: AbortSignal): Promise<void>;
  fechar(): Promise<void>;
}
