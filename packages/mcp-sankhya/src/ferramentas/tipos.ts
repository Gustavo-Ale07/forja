import { z } from 'zod';
import type { ConfigArquivo } from '../config/esquema.js';
import type { Gateway } from '../gateway/tipos.js';
import type { Capturador, Construtor } from '../navegador/tipos.js';
import type { DefinicaoPorteiro } from '../porteiro/porteiro.js';
import type { Confirmacoes } from './confirmacoes.js';

export interface ContextoExecucao {
  gateway: Gateway;
  /** Criado sob demanda (abre o navegador só quando preciso). */
  construtor(): Construtor;
  config: ConfigArquivo;
  ambiente: string;
  usuario: string;
  planoId?: string | undefined;
  passoId?: number | undefined;
  diretorioPlanos: string;
  novoCapturador(ferramenta: string): Capturador;
  confirmacoes: Confirmacoes;
  agora(): Date;
}

export interface ResultadoFerramenta {
  dados: unknown;
  /** 'executado' (padrão), 'já existia' (passo cumprido sem alterar nada) ou 'previa' (nada foi alterado). */
  motivo?: 'executado' | 'já existia' | 'previa';
  antes?: unknown;
  depois?: unknown;
  capturaPath?: string | undefined;
}

export interface Ferramenta extends DefinicaoPorteiro {
  descricao: string;
  /** Faz chamadas ao Sankhya (exige a trava de ambiente antes). */
  usaSankhya: boolean;
  /** Usa o navegador (uma chamada por vez). */
  usaNavegador: boolean;
  executar(params: never, ctx: ContextoExecucao): Promise<ResultadoFerramenta>;
}

/** Campos de controle aceitos por toda ferramenta (o porteiro usa plano_id/passo_id). */
export const CONTROLE = {
  plano_id: z.string().max(64).optional().describe('Id do plano aprovado (planos/<id>.json). Obrigatório para alterações.'),
  passo_id: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .optional()
    .describe('Número do passo do plano que esta chamada executa.'),
};

/** Nome de campo/coluna Oracle simples, em maiúsculas. */
export const nomeColuna = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_$#]{0,29}$/, 'nome de campo inválido'));

/** Ajuda de tipo: define a ferramenta com o tipo dos parâmetros vindo do schema. */
export function definir<S extends z.ZodType>(
  f: Omit<Ferramenta, 'executar' | 'schema'> & {
    schema: S;
    executar(params: z.output<S>, ctx: ContextoExecucao): Promise<ResultadoFerramenta>;
  },
): Ferramenta {
  return f as unknown as Ferramenta;
}
