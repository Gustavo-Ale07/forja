import pkg from 'node-sql-parser';
import { ehColunaSecreta } from '../comum/mascara.js';
import { asteriscoInterno, ErroLexico, identificadores, OPERADORES_CONJUNTO, palavraProibida, tokenizar, type Token } from './lexico.js';

const { Parser } = pkg;
const parser = new Parser();
/** Não há dialeto Oracle no node-sql-parser; o de PostgreSQL aceita a maior parte do SQL do Sankhya. */
const DIALETO = { database: 'PostgresQL' } as const;

export const TAMANHO_MAXIMO_SQL = 20_000;

export type ResultadoValidacao =
  | { ok: true; tabelas: string[]; identificadores: string[] }
  | { ok: false; motivo: string };

const recusa = (motivo: string): ResultadoValidacao => ({ ok: false, motivo });

/**
 * Valida um SQL de leitura: exatamente um SELECT (ou WITH ... SELECT), sem `;`, sem comentários,
 * sem DML/DDL/PLSQL e sem pacotes de sistema. Duas barreiras independentes: léxico próprio e parser.
 */
export function validarSelect(sql: string): ResultadoValidacao {
  if (typeof sql !== 'string' || sql.trim() === '') return recusa('SQL vazio.');
  if (sql.length > TAMANHO_MAXIMO_SQL) return recusa(`SQL maior que ${TAMANHO_MAXIMO_SQL} caracteres.`);

  let tokens: Token[];
  try {
    tokens = tokenizar(sql);
  } catch (e) {
    return recusa(`SQL inválido: ${e instanceof ErroLexico ? e.message : 'erro de leitura'}.`);
  }
  if (tokens.some((t) => t.tipo === 'comentario')) {
    return recusa('Comentários (-- ou /* */) não são aceitos no SQL.');
  }
  if (tokens.some((t) => t.tipo === 'ponto_virgula')) {
    return recusa('O caractere ";" não é aceito: envie um único comando, sem ponto e vírgula.');
  }
  const primeiro = tokens[0];
  if (!primeiro || primeiro.tipo !== 'identificador' || !['SELECT', 'WITH'].includes(primeiro.normal)) {
    return recusa('Só é aceito SELECT ou WITH ... SELECT.');
  }
  const proibida = palavraProibida(tokens);
  if (proibida) return recusa(`Palavra não permitida em consulta de leitura: ${proibida}.`);
  const conjunto = tokens.find((t) => t.tipo === 'identificador' && OPERADORES_CONJUNTO.has(t.normal));
  if (conjunto) {
    return recusa(`${conjunto.normal} não é aceito: faça consultas separadas (a máscara de colunas sensíveis depende do nome da coluna).`);
  }
  if (asteriscoInterno(tokens)) {
    return recusa('"*" só é aceito no SELECT de fora (ou em COUNT(*)); dentro de subconsulta, CTE ou função, liste as colunas.');
  }

  const idents = identificadores(tokens);
  const secreta = idents.find((i) => ehColunaSecreta(i));
  if (secreta) {
    return recusa(
      `A consulta referencia "${secreta}", nome de coluna sensível (SENHA, PASSWORD, TOKEN, SECRET, CHAVE, KEY). ` +
        'Essas colunas não podem ser lidas nem usadas em filtros; num SELECT * elas voltam mascaradas.',
    );
  }

  let ast: unknown;
  try {
    ast = parser.astify(sql, DIALETO);
  } catch {
    return recusa(
      'O validador não reconheceu o SQL. Use sintaxe padrão: JOIN explícito em vez de (+), ' +
        'ROWNUM em vez de FETCH FIRST, sem hints.',
    );
  }
  const comandos = Array.isArray(ast) ? ast : [ast];
  if (comandos.length !== 1) return recusa('Envie exatamente um comando.');
  const tipo = (comandos[0] as { type?: unknown } | null)?.type;
  if (tipo !== 'select') return recusa(`Só SELECT é aceito (recebido: ${String(tipo)}).`);

  let lista: string[];
  try {
    lista = parser.tableList(sql, DIALETO);
  } catch {
    return recusa('Não foi possível identificar as tabelas do SQL.');
  }
  const tabelas = new Set<string>();
  for (const item of lista) {
    const [operacao, , tabela] = item.split('::');
    if (operacao !== 'select') return recusa(`Operação não permitida: ${operacao}.`);
    if (tabela) tabelas.add(tabela.toUpperCase());
  }
  return { ok: true, tabelas: [...tabelas], identificadores: idents };
}

/** Troca os marcadores `?` (fora de string/aspas) por 0, para o parser aceitar a expressão. */
export function trocarMarcadores(expr: string): string {
  let saida = '';
  let aspas: string | undefined;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (aspas) {
      if (c === aspas) aspas = undefined;
      saida += c;
    } else if (c === "'" || c === '"') {
      aspas = c;
      saida += c;
    } else saida += c === '?' ? '0' : c;
  }
  return saida;
}

/** Quantos marcadores `?` há fora de string. */
export function contarMarcadores(expr: string): number {
  const trocado = trocarMarcadores(expr);
  let n = 0;
  for (let i = 0; i < expr.length; i++) if (expr[i] === '?' && trocado[i] === '0') n++;
  return n;
}

/**
 * Valida a expressão de filtro do CRUD (vai para um WHERE dentro do Sankhya): sem subconsulta,
 * sem DML, sem comentários, sem `;`. Usa as mesmas barreiras, embrulhando num SELECT fictício.
 */
export function validarFiltro(expressao: string): ResultadoValidacao {
  let tokens: Token[];
  try {
    tokens = tokenizar(expressao);
  } catch (e) {
    return recusa(`Filtro inválido: ${e instanceof ErroLexico ? e.message : 'erro de leitura'}.`);
  }
  if (tokens.some((t) => t.tipo === 'identificador' && ['SELECT', 'WITH', 'FROM'].includes(t.normal))) {
    return recusa('O filtro não pode conter subconsulta (SELECT/WITH/FROM).');
  }
  const r = validarSelect(`SELECT 1 FROM FILTRO_FORJA WHERE ${trocarMarcadores(expressao)}`);
  if (!r.ok) return r;
  return { ok: true, tabelas: [], identificadores: r.identificadores.filter((i) => i !== 'FILTRO_FORJA') };
}
