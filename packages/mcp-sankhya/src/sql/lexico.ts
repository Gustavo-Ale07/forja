/**
 * Léxico mínimo de SQL Oracle, usado como primeira barreira (antes do parser). Ele é a autoridade
 * sobre onde começam e terminam strings e comentários, com a semântica do Oracle: '' escapa aspas,
 * barra invertida NÃO escapa nada. Assim um `\'` não consegue "esconder" um `;` do porteiro.
 */

export type TipoToken =
  | 'identificador'
  | 'identificador_citado'
  | 'string'
  | 'numero'
  | 'comentario'
  | 'ponto_virgula'
  | 'simbolo';

export interface Token {
  tipo: TipoToken;
  /** Texto original. Para identificador sem aspas, também em `normal` (maiúsculo). */
  texto: string;
  normal: string;
}

export class ErroLexico extends Error {}

const INICIO_IDENT = /[A-Za-z_]/;
const CORPO_IDENT = /[A-Za-z0-9_$#]/;

export function tokenizar(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const prox = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && prox === '-') {
      const fim = sql.indexOf('\n', i);
      const ate = fim === -1 ? n : fim;
      tokens.push(tok('comentario', sql.slice(i, ate)));
      i = ate;
      continue;
    }
    if (c === '/' && prox === '*') {
      const fim = sql.indexOf('*/', i + 2);
      if (fim === -1) throw new ErroLexico('comentário /* sem fechamento');
      tokens.push(tok('comentario', sql.slice(i, fim + 2)));
      i = fim + 2;
      continue;
    }
    // Quoting alternativo do Oracle (q'[...]'): recusado, é raro e serve para esconder conteúdo.
    if ((c === 'q' || c === 'Q') && prox === "'") {
      throw new ErroLexico("literal q'...' (quoting alternativo) não é aceito");
    }
    if ((c === 'n' || c === 'N') && (prox === 'q' || prox === 'Q') && sql[i + 2] === "'") {
      throw new ErroLexico("literal nq'...' (quoting alternativo) não é aceito");
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new ErroLexico('string sem fechamento');
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      tokens.push(tok('string', sql.slice(i, j + 1)));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const fim = sql.indexOf('"', i + 1);
      if (fim === -1) throw new ErroLexico('identificador entre aspas sem fechamento');
      const texto = sql.slice(i, fim + 1);
      tokens.push({ tipo: 'identificador_citado', texto, normal: texto.slice(1, -1).toUpperCase() });
      i = fim + 1;
      continue;
    }
    if (INICIO_IDENT.test(c)) {
      let j = i + 1;
      while (j < n && CORPO_IDENT.test(sql[j]!)) j++;
      const texto = sql.slice(i, j);
      tokens.push({ tipo: 'identificador', texto, normal: texto.toUpperCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && prox !== undefined && /[0-9]/.test(prox))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j]!)) j++;
      tokens.push(tok('numero', sql.slice(i, j)));
      i = j;
      continue;
    }
    if (c === ';') {
      tokens.push(tok('ponto_virgula', c));
      i++;
      continue;
    }
    if (c.charCodeAt(0) > 127) {
      throw new ErroLexico(`caractere fora do ASCII fora de string: U+${c.charCodeAt(0).toString(16)}`);
    }
    tokens.push(tok('simbolo', c));
    i++;
  }
  return tokens;
}

function tok(tipo: TipoToken, texto: string): Token {
  return { tipo, texto, normal: texto.toUpperCase() };
}

/** Palavras que nunca podem aparecer (fora de string/comentário) num SQL de leitura. */
export const PALAVRAS_PROIBIDAS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'EXECUTE',
  'EXEC',
  'CALL',
  'BEGIN',
  'DECLARE',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'LOCK',
  'RENAME',
  'INTO',
  'PURGE',
  'FLASHBACK',
  'ANALYZE',
  'AUDIT',
  'NOAUDIT',
]);

/** Prefixos de objetos perigosos ou de outros esquemas/sistema. */
export const PREFIXOS_PROIBIDOS = ['DBMS_', 'UTL_', 'DBA_', 'V$', 'GV$', 'X$', 'CDB_'];
export const IDENTIFICADORES_PROIBIDOS = new Set([
  'SYS',
  'SYSTEM',
  'HTTPURITYPE',
  'URITYPE',
  'DBURITYPE',
  'XDBURITYPE',
  // XML/JSON/CURSOR: transformam linhas inteiras (inclusive colunas sensíveis) em texto, contornando a máscara.
  'XMLTYPE',
  'XMLQUERY',
  'XMLTABLE',
  'XMLSERIALIZE',
  'XMLCAST',
  'XMLEXISTS',
  'XMLSEQUENCE',
  'SYS_XMLGEN',
  'SYS_XMLAGG',
  'EXTRACTVALUE',
  'CURSOR',
  'JSON_OBJECT',
  'JSON_ARRAYAGG',
  'JSON_OBJECTAGG',
]);

/** Operadores de conjunto: o nome da coluna de saída vem do 1º ramo, então a máscara por nome não vale. */
export const OPERADORES_CONJUNTO = new Set(['UNION', 'INTERSECT', 'MINUS', 'EXCEPT']);

/**
 * `*` dentro de parênteses (subconsulta, CTE, função) expõe colunas sem o nome aparecer no SQL.
 * Lá dentro só vale como multiplicação ou em COUNT(*). No nível de fora, SELECT * é aceito porque
 * as colunas sensíveis voltam mascaradas pelo nome.
 */
export function asteriscoInterno(tokens: Token[]): boolean {
  let nivel = 0;
  const antesDeLista = new Set(['SELECT', 'DISTINCT', 'ALL', 'UNIQUE']);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.tipo !== 'simbolo') continue;
    if (t.texto === '(') nivel++;
    else if (t.texto === ')') nivel--;
    else if (t.texto === '*' && nivel > 0) {
      const ant = tokens[i - 1];
      if (ant?.texto === '(' && tokens[i - 2]?.normal === 'COUNT') continue;
      const operando =
        ant !== undefined &&
        (ant.tipo === 'numero' ||
          ant.tipo === 'identificador_citado' ||
          (ant.tipo === 'simbolo' && ant.texto === ')') ||
          (ant.tipo === 'identificador' && !antesDeLista.has(ant.normal)));
      if (!operando) return true;
    }
  }
  return false;
}

/** Primeira palavra proibida encontrada fora de string/comentário, se houver. */
export function palavraProibida(tokens: Token[]): string | undefined {
  for (const t of tokens) {
    if (t.tipo !== 'identificador') continue;
    if (PALAVRAS_PROIBIDAS.has(t.normal)) return t.normal;
    if (IDENTIFICADORES_PROIBIDOS.has(t.normal)) return t.normal;
    if (PREFIXOS_PROIBIDOS.some((p) => t.normal.startsWith(p))) return t.normal;
  }
  for (const t of tokens) {
    if (t.tipo === 'simbolo' && t.texto === '@') return '@ (database link)';
  }
  return undefined;
}

/** Identificadores (com ou sem aspas), já em maiúsculas, para checagem conservadora de alcance. */
export function identificadores(tokens: Token[]): string[] {
  return tokens
    .filter((t) => t.tipo === 'identificador' || t.tipo === 'identificador_citado')
    .map((t) => t.normal);
}
