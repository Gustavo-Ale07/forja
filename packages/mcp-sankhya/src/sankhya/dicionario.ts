import { ForjaErro } from '../comum/erros.js';
import type { Gateway, ResultadoQuery } from '../gateway/tipos.js';
import { normalizarTabela } from '../porteiro/tabelas.js';

/**
 * Consultas de dicionário e de estrutura física. Somente SELECT, montadas pelo servidor (não pelo
 * modelo). O nome da tabela só entra no SQL depois de validado como identificador Oracle simples.
 */

export function nomeSeguro(bruto: string): string {
  const t = normalizarTabela(bruto);
  if (!t.valido) throw new ForjaErro('PARAMETRO_INVALIDO', `Nome inválido: "${bruto}".`);
  return t.nome;
}

export const SQL = {
  usuarioBanco: () => 'SELECT USER AS USUARIO FROM DUAL',
  tabela: (t: string) => `SELECT NOMETAB, DESCRTAB, TIPONUMERACAO FROM TDDTAB WHERE NOMETAB = '${nomeSeguro(t)}'`,
  campos: (t: string) =>
    `SELECT NUCAMPO, NOMECAMPO, DESCRCAMPO, TIPCAMPO FROM TDDCAM WHERE NOMETAB = '${nomeSeguro(t)}' ORDER BY NUCAMPO`,
  colunas: (t: string) =>
    `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = '${nomeSeguro(t)}' ORDER BY COLUMN_ID`,
  instancias: (t: string) => `SELECT NOMEINSTANCIA FROM TDDINS WHERE NOMETAB = '${nomeSeguro(t)}'`,
  opcoes: (t: string) =>
    `SELECT C.NOMECAMPO, O.VALOR, O.OPCAO FROM TDDOPC O JOIN TDDCAM C ON C.NUCAMPO = O.NUCAMPO WHERE C.NOMETAB = '${nomeSeguro(t)}' ORDER BY C.NOMECAMPO, O.VALOR`,
  /** TDDPCO é chave/valor por campo; só os atributos que a Forja confere. */
  atributos: (t: string) =>
    `SELECT C.NOMECAMPO, P.NOME, P.VALOR FROM TDDPCO P JOIN TDDCAM C ON C.NUCAMPO = P.NUCAMPO WHERE C.NOMETAB = '${nomeSeguro(t)}' AND P.NOME IN ('requerido', 'nullable', 'visivel') ORDER BY C.NOMECAMPO, P.NOME`,
  chavePrimaria: (t: string) =>
    `SELECT CC.COLUMN_NAME FROM USER_CONSTRAINTS UC JOIN USER_CONS_COLUMNS CC ON CC.CONSTRAINT_NAME = UC.CONSTRAINT_NAME WHERE UC.TABLE_NAME = '${nomeSeguro(t)}' AND UC.CONSTRAINT_TYPE = 'P' ORDER BY CC.POSITION`,
};

/** Linhas como objetos, com nomes de coluna em maiúsculas. */
export function comoObjetos(r: ResultadoQuery): Record<string, unknown>[] {
  const cols = r.columns.map((c) => c.toUpperCase());
  return r.rows.map((linha) => Object.fromEntries(cols.map((c, i) => [c, linha[i] ?? null])));
}

export interface ColunaFisica {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  DATA_LENGTH: number;
  DATA_PRECISION: number | null;
  NULLABLE: string;
}

export interface CampoDicionario {
  NUCAMPO: number;
  NOMECAMPO: string;
  DESCRCAMPO: string | null;
  TIPCAMPO: string | null;
}

export interface Estrutura {
  tabela: string;
  existe: boolean;
  dicionario: { NOMETAB: string; DESCRTAB: string | null; TIPONUMERACAO: string | null } | null;
  instancias: string[];
  campos: CampoDicionario[];
  colunas: ColunaFisica[];
  opcoes: Array<{ NOMECAMPO: string; VALOR: string; OPCAO: string | null }>;
  /** Atributos de tela (TDDPCO): requerido, nullable, visivel. */
  atributos: Array<{ NOMECAMPO: string; NOME: string; VALOR: string | null }>;
  chavePrimaria: string[];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function lerEstrutura(gw: Gateway, tabela: string, signal?: AbortSignal): Promise<Estrutura> {
  const nome = nomeSeguro(tabela);
  const q = async (sql: string) => comoObjetos(await gw.executeQuery(sql, signal));
  const tab = await q(SQL.tabela(nome));
  const colunas = (await q(SQL.colunas(nome))).map((c) => ({
    COLUMN_NAME: String(c.COLUMN_NAME),
    DATA_TYPE: String(c.DATA_TYPE),
    DATA_LENGTH: Number(c.DATA_LENGTH),
    DATA_PRECISION: num(c.DATA_PRECISION),
    NULLABLE: String(c.NULLABLE),
  }));
  const t0 = tab[0];
  if (!t0 && colunas.length === 0) {
    return { tabela: nome, existe: false, dicionario: null, instancias: [], campos: [], colunas: [], opcoes: [], atributos: [], chavePrimaria: [] };
  }
  const campos = (await q(SQL.campos(nome))).map((c) => ({
    NUCAMPO: Number(c.NUCAMPO),
    NOMECAMPO: String(c.NOMECAMPO),
    DESCRCAMPO: str(c.DESCRCAMPO),
    TIPCAMPO: str(c.TIPCAMPO),
  }));
  const instancias = (await q(SQL.instancias(nome))).map((i) => String(i.NOMEINSTANCIA));
  const opcoes = (await q(SQL.opcoes(nome))).map((o) => ({
    NOMECAMPO: String(o.NOMECAMPO),
    VALOR: String(o.VALOR),
    OPCAO: str(o.OPCAO),
  }));
  const atributos = (await q(SQL.atributos(nome))).map((a) => ({
    NOMECAMPO: String(a.NOMECAMPO),
    NOME: String(a.NOME),
    VALOR: str(a.VALOR),
  }));
  const chavePrimaria = (await q(SQL.chavePrimaria(nome))).map((c) => String(c.COLUMN_NAME));
  return {
    tabela: nome,
    existe: true,
    dicionario: t0 ? { NOMETAB: String(t0.NOMETAB), DESCRTAB: str(t0.DESCRTAB), TIPONUMERACAO: str(t0.TIPONUMERACAO) } : null,
    instancias,
    campos,
    colunas,
    opcoes,
    atributos,
    chavePrimaria,
  };
}

/** Instância (entidade do CRUD) da tabela: config `instancias` ou a única instância em TDDINS. */
export async function resolverInstancia(
  gw: Gateway,
  tabela: string,
  mapa: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const nome = nomeSeguro(tabela);
  const configurada = mapa[nome];
  if (configurada) return configurada;
  const linhas = comoObjetos(await gw.executeQuery(SQL.instancias(nome), signal));
  const nomes = linhas.map((l) => String(l.NOMEINSTANCIA));
  if (nomes.length === 1) return nomes[0]!;
  if (nomes.length === 0) {
    throw new ForjaErro('RECUSADO_EXECUCAO', `A tabela ${nome} não tem instância no dicionário (TDDINS).`);
  }
  throw new ForjaErro(
    'RECUSADO_EXECUCAO',
    `A tabela ${nome} tem ${nomes.length} instâncias (${nomes.join(', ')}). Defina qual usar em "instancias" no forja.config.yaml.`,
  );
}
