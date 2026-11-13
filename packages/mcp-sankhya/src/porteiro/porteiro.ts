import { z } from 'zod';
import { hashParametros } from '../comum/canonico.js';
import { mensagemSegura } from '../comum/mascara.js';
import type { ConfigArquivo, Nivel } from '../config/esquema.js';
import { tokenizar, PALAVRAS_PROIBIDAS } from '../sql/lexico.js';
import { verificarAprovacaoPasso, verificarAssinaturaPlano, type Plano } from './planos.js';
import {
  casaAlgum,
  ehTabelaAd,
  normalizarTabela,
  PADROES_DICIONARIO,
  PADROES_FISCAL_FINANCEIRO,
  PADROES_USUARIOS_PERMISSOES,
} from './tabelas.js';

export type Operacao = 'leitura' | 'gravacao' | 'estrutura';

export interface Alvo {
  /** Nome como veio do modelo; o porteiro normaliza. */
  tabela: string;
  operacao: Operacao;
}

/** O que a ferramenta declara sobre uma chamada, extraído dos parâmetros brutos (antes do zod). */
export interface Analise {
  alvos: Alvo[];
  /** Quantos registros a chamada grava (gravar_registros). */
  registros?: number;
  /** SQL a ser checado pelas travas léxicas (consultar_sql). */
  sql?: string;
  /** Identificadores lidos (SQL/filtro), checados contra tabelas bloqueadas para leitura. */
  identificadoresLidos?: string[];
  /** Algum UPDATE sem chave/filtro. */
  updateSemFiltro?: boolean;
  /** Algum DELETE (em lote ou não): não existe nesta fase. */
  delete?: boolean;
}

export interface DefinicaoPorteiro {
  nome: string;
  /** Altera algo no Sankhya (ou no estado da Forja que dele depende): exige plano. */
  altera: boolean;
  /** Ferramentas internas da Forja (ex.: propor_plano) não dependem de ambiente Sankhya. */
  schema: z.ZodType;
  analisar(bruto: Record<string, unknown>): Analise;
  /** Validação além do zod (ex.: parser de SQL). Devolve o motivo da recusa. */
  validarExtra?(params: unknown): string | undefined;
}

export interface DependenciasPorteiro {
  config: ConfigArquivo;
  ambiente: string;
  usuario: string | undefined;
  chaveAprovacao: string;
  agora(): Date;
  lerPlano(id: string): Plano | undefined;
  passoJaExecutado(planoId: string, passo: number): boolean;
}

export const NOMES_REGRAS = {
  1: 'usuário e perfil',
  2: 'plano aprovado',
  3: 'ambiente',
  4: 'nível da ação',
  5: 'trava fixa',
  6: 'regra da empresa',
  7: 'parâmetros',
} as const;
export type NumeroRegra = keyof typeof NOMES_REGRAS;

export type Decisao =
  | {
      aceito: true;
      usuario: string;
      perfil: string;
      ambiente: string;
      nivel: Nivel;
      params: unknown;
      planoId?: string;
      passoId?: number;
    }
  | {
      aceito: false;
      regra: NumeroRegra;
      motivo: string;
      usuario?: string;
      perfil?: string;
      ambiente: string;
      planoId?: string;
      passoId?: number;
    };

class Recusa {
  constructor(
    readonly regra: NumeroRegra,
    readonly motivo: string,
  ) {}
}

/**
 * O porteiro. Confere as 7 regras na ordem e para no primeiro "não". Não faz I/O de rede:
 * uma recusa nunca chega ao Sankhya.
 */
export function avaliar(def: DefinicaoPorteiro, bruto: unknown, dep: DependenciasPorteiro): Decisao {
  const ambiente = dep.ambiente;
  const params: Record<string, unknown> =
    bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
  const ctx: { usuario?: string; perfil?: string; planoId?: string; passoId?: number } = {};
  try {
    // 1. Usuário e perfil
    const usuario = dep.usuario?.trim();
    if (!usuario) throw new Recusa(1, 'Usuário não identificado (FORJA_USUARIO vazio).');
    ctx.usuario = usuario;
    const perfilNome = dep.config.usuarios[usuario];
    if (!perfilNome) throw new Recusa(1, `Usuário "${usuario}" não está cadastrado em forja.config.yaml.`);
    const perfil = dep.config.perfis[perfilNome];
    if (!perfil) throw new Recusa(1, `Perfil "${perfilNome}" do usuário "${usuario}" não existe.`);
    ctx.perfil = perfilNome;

    const nivel: Nivel = perfil.acoes[ambiente]?.[def.nome] ?? 'bloqueado';

    // 2. Plano (alterações sempre; leitura só se o nível exigir aprovação)
    let plano: Plano | undefined;
    let passoN: number | undefined;
    const exigePlano = def.altera || nivel === 'com_aprovacao';
    if (exigePlano) {
      const planoId = params.plano_id;
      const passoBruto = params.passo_id;
      if (typeof planoId !== 'string' || planoId === '') {
        throw new Recusa(2, `"${def.nome}" altera dados ou estrutura e exige plano_id e passo_id de um plano aprovado.`);
      }
      ctx.planoId = planoId;
      const passoNum = typeof passoBruto === 'string' && /^\d+$/.test(passoBruto) ? Number(passoBruto) : passoBruto;
      if (typeof passoNum !== 'number' || !Number.isInteger(passoNum) || passoNum <= 0) {
        throw new Recusa(2, 'passo_id ausente ou inválido (número do passo no plano).');
      }
      passoN = passoNum;
      ctx.passoId = passoNum;
      try {
        plano = dep.lerPlano(planoId);
      } catch (e) {
        throw new Recusa(2, mensagemSegura(e));
      }
      if (!plano) throw new Recusa(2, `Plano "${planoId}" não encontrado em planos/.`);
      const assinatura = verificarAssinaturaPlano(plano, dep.chaveAprovacao);
      if (assinatura) throw new Recusa(2, assinatura);
      const passo = plano.passos.find((s) => s.n === passoN);
      if (!passo) throw new Recusa(2, `O plano "${planoId}" não tem passo ${passoN}.`);
      if (passo.ferramenta !== def.nome) {
        throw new Recusa(2, `O passo ${passoN} do plano "${planoId}" é de "${passo.ferramenta}", não de "${def.nome}".`);
      }
      if (hashParametros(params) !== hashParametros(passo.parametros)) {
        throw new Recusa(
          2,
          `Os parâmetros não conferem com o passo ${passoN} do plano "${planoId}" (hash diferente). Use exatamente os parâmetros aprovados.`,
        );
      }
      if (dep.passoJaExecutado(planoId, passoN)) {
        throw new Recusa(2, `O passo ${passoN} do plano "${planoId}" já foi executado. Cada passo roda uma vez.`);
      }
    }

    // 3. Ambiente
    if (!perfil.ambientes.includes(ambiente)) {
      throw new Recusa(3, `O perfil "${perfilNome}" não tem acesso ao ambiente "${ambiente}".`);
    }
    const amb = dep.config.ambientes[ambiente];
    if (!amb) throw new Recusa(3, `Ambiente "${ambiente}" não configurado.`);
    if (def.altera && amb.somente_leitura) {
      throw new Recusa(3, `O ambiente "${ambiente}" está marcado como somente leitura.`);
    }

    // 4. Nível da ação
    if (nivel === 'bloqueado') {
      throw new Recusa(4, `A ação "${def.nome}" está bloqueada para o perfil "${perfilNome}" no ambiente "${ambiente}".`);
    }
    if (nivel === 'com_aprovacao') {
      const passo = plano!.passos.find((s) => s.n === passoN)!;
      const motivo = verificarAprovacaoPasso(plano!, passo, dep.chaveAprovacao);
      if (motivo) throw new Recusa(4, motivo);
    }

    // 5. Travas fixas
    let analise: Analise;
    try {
      analise = def.analisar(params);
    } catch {
      analise = { alvos: [] };
    }
    const trava = travasFixas(analise);
    if (trava) throw new Recusa(5, trava);

    // 6. Regras da empresa
    const regra = regrasEmpresa(analise, dep, perfil.tabelas_bloqueadas);
    if (regra) throw new Recusa(6, regra);

    // 7. Parâmetros
    const r = def.schema.safeParse(params);
    if (!r.success) throw new Recusa(7, `Parâmetros inválidos: ${z.prettifyError(r.error)}`);
    const extra = def.validarExtra?.(r.data);
    if (extra) throw new Recusa(7, extra);

    const aceito: Decisao = { aceito: true, usuario, perfil: perfilNome, ambiente, nivel, params: r.data };
    if (ctx.planoId) aceito.planoId = ctx.planoId;
    if (ctx.passoId !== undefined) aceito.passoId = ctx.passoId;
    return aceito;
  } catch (e) {
    const recusa = e instanceof Recusa ? e : new Recusa(7, `Falha ao avaliar: ${mensagemSegura(e)}`);
    return { aceito: false, regra: recusa.regra, motivo: recusa.motivo, ambiente, ...ctx };
  }
}

/** Regra 5: nada aqui é configurável. */
export function travasFixas(a: Analise): string | undefined {
  if (a.delete) return 'DELETE não é permitido pela Forja (nem em lote, nem individual).';
  if (a.updateSemFiltro) return 'UPDATE sem chave/filtro não é permitido: todo registro alterado precisa da chave primária completa.';
  if (a.sql !== undefined) {
    try {
      const proibida = tokenizar(a.sql).find((t) => t.tipo === 'identificador' && PALAVRAS_PROIBIDAS.has(t.normal));
      if (proibida) {
        return `Só leitura (SELECT) é permitida em SQL; encontrado "${proibida.normal}". DML e DDL são bloqueados.`;
      }
    } catch {
      /* SQL ilegível: a regra 7 recusa com o motivo exato */
    }
  }
  for (const alvo of a.alvos) {
    const t = normalizarTabela(alvo.tabela);
    if (alvo.operacao === 'estrutura') {
      if (casaAlgum(t.nome, PADROES_USUARIOS_PERMISSOES)) {
        return `Estrutura de usuários e permissões do Sankhya (${t.nome}) nunca é alterada pela Forja.`;
      }
      if (!ehTabelaAd(t)) {
        return `Estrutura só pode ser criada/alterada em tabelas adicionais (prefixo AD_). "${t.original}" é tabela nativa ou nome inválido.`;
      }
    }
    if (alvo.operacao === 'gravacao') {
      if (casaAlgum(t.nome, PADROES_USUARIOS_PERMISSOES)) {
        return `Usuários e permissões do Sankhya (${t.nome}) nunca são alterados pela Forja.`;
      }
      const fiscal = casaAlgum(t.nome, PADROES_FISCAL_FINANCEIRO);
      if (fiscal) return `Tabela fiscal/financeira (${t.nome}, regra ${fiscal}): gravação bloqueada.`;
      if (casaAlgum(t.nome, PADROES_DICIONARIO)) {
        return `O dicionário de dados (${t.nome}) só muda pelas ferramentas de estrutura, nunca por gravação de registros.`;
      }
      if (!t.valido) return `Nome de tabela inválido: "${t.original}".`;
    }
  }
  return undefined;
}

/** Regra 6: horário, limite de registros, tabelas fora do alcance. */
function regrasEmpresa(
  a: Analise,
  dep: DependenciasPorteiro,
  bloqueadasPerfil: readonly string[],
): string | undefined {
  const { regras, fuso } = dep.config;
  if (regras.horario) {
    const { dia, minutos } = horaLocal(dep.agora(), fuso);
    const [hi, mi] = regras.horario.inicio.split(':').map(Number) as [number, number];
    const [hf, mf] = regras.horario.fim.split(':').map(Number) as [number, number];
    const dentro = regras.horario.dias.includes(dia) && minutos >= hi * 60 + mi && minutos <= hf * 60 + mf;
    if (!dentro) {
      return `Fora do horário permitido (${regras.horario.inicio}–${regras.horario.fim}, dias ${regras.horario.dias.join(',')}, fuso ${fuso}).`;
    }
  }
  if (a.registros !== undefined && a.registros > regras.limite_registros_por_execucao) {
    return `${a.registros} registros excedem o limite por execução (${regras.limite_registros_por_execucao}).`;
  }
  for (const alvo of a.alvos) {
    const t = normalizarTabela(alvo.tabela);
    const p = casaAlgum(t.nome, bloqueadasPerfil);
    if (p) return `A tabela ${t.nome} está fora do alcance do perfil (regra ${p}).`;
    if (alvo.operacao === 'leitura') {
      const l = casaAlgum(t.nome, regras.leitura_bloqueada);
      if (l) return `Leitura da tabela ${t.nome} bloqueada (regra ${l}).`;
    }
    if (alvo.operacao === 'gravacao' && !ehTabelaAd(t) && !casaAlgum(t.nome, regras.gravacao_nativa_liberada)) {
      return `Gravação em tabela nativa (${t.nome}) não está liberada; por padrão só tabelas AD_.`;
    }
  }
  for (const ident of a.identificadoresLidos ?? []) {
    const p = casaAlgum(ident, bloqueadasPerfil);
    if (p) return `A consulta referencia ${ident}, fora do alcance do perfil (regra ${p}).`;
    const l = casaAlgum(ident, regras.leitura_bloqueada);
    if (l) return `A consulta referencia ${ident}, de leitura bloqueada (regra ${l}).`;
  }
  return undefined;
}

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function horaLocal(data: Date, fuso: string): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(data);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return { dia: DIAS[v('weekday')] ?? -1, minutos: Number(v('hour')) * 60 + Number(v('minute')) };
}
