/**
 * Normalização e classificação de nomes de tabela. Toda comparação usa o nome normalizado,
 * então "tgfcab", " TGFCAB " e "TgfCab" são a mesma tabela.
 */

/** Nome Oracle simples (até 30), só ASCII. */
const NOME_VALIDO = /^[A-Z][A-Z0-9_$#]{0,29}$/;
/** Tabela adicional de verdade: AD_ seguido de pelo menos um caractere útil. */
const NOME_AD = /^AD_[A-Z0-9][A-Z0-9_]{0,26}$/;

export interface NomeTabela {
  original: string;
  nome: string;
  /** Só ASCII, sem espaços internos, formato Oracle. */
  valido: boolean;
}

export function normalizarTabela(bruto: unknown): NomeTabela {
  const original = typeof bruto === 'string' ? bruto : String(bruto ?? '');
  // Remove caracteres invisíveis só para comparar; a validade continua exigindo ASCII puro.
  const nome = original.normalize('NFKC').replace(/[​-‍﻿]/g, '').trim().toUpperCase();
  // eslint-disable-next-line no-control-regex
  const soAscii = /^[\x00-\x7F]*$/.test(original.trim());
  return { original, nome, valido: soAscii && NOME_VALIDO.test(nome) };
}

export function ehTabelaAd(t: NomeTabela): boolean {
  return t.valido && NOME_AD.test(t.nome);
}

/** Nome casa com padrão "TGFCAB" (exato) ou "TSI*" (prefixo). */
export function casaPadrao(nome: string, padrao: string): boolean {
  const p = padrao.toUpperCase();
  return p.endsWith('*') ? nome.startsWith(p.slice(0, -1)) : nome === p;
}

export const casaAlgum = (nome: string, padroes: readonly string[]) =>
  padroes.find((p) => casaPadrao(nome, p));

/** Usuários e permissões do Sankhya: nunca tocados (trava fixa). */
export const PADROES_USUARIOS_PERMISSOES = ['TSI*'] as const;

/** Fiscal e financeiro: nunca gravados (trava fixa). */
export const PADROES_FISCAL_FINANCEIRO = [
  'TGFCAB',
  'TGFITE',
  'TGFFIN',
  'TGFMBC',
  'TGFIMP',
  'TGFDIN',
  'TGFTOP',
  'TCB*',
  'TGFLIV*',
  'TGFNFE*',
] as const;

/** Dicionário de dados: só muda pelas telas oficiais (ferramentas de estrutura). */
export const PADROES_DICIONARIO = ['TDD*', 'TRD*'] as const;
