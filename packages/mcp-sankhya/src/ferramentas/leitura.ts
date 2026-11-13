import { z } from 'zod';
import { ForjaErro } from '../comum/erros.js';
import { ehColunaSecreta, MASCARA } from '../comum/mascara.js';
import { normalizarTabela } from '../porteiro/tabelas.js';
import { lerEstrutura, resolverInstancia } from '../sankhya/dicionario.js';
import { tokenizar, identificadores } from '../sql/lexico.js';
import { contarMarcadores, validarFiltro, validarSelect } from '../sql/validar.js';
import { CONTROLE, definir, nomeColuna } from './tipos.js';

export const LIMITE_LINHAS = 1000;
export const TEMPO_CONSULTA_MS = 30_000;

const nomeTabela = z
  .string()
  .min(1)
  .max(40)
  .describe('Nome da tabela no banco (ex.: TGFPAR, AD_MINHATABELA).');

/** Identificadores de um texto, sem lançar (texto ilegível = nenhum; a regra 7 recusa depois). */
function identsSeguros(texto: unknown): string[] {
  if (typeof texto !== 'string') return [];
  try {
    return identificadores(tokenizar(texto));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- ler_dicionario

export const lerDicionario = definir({
  nome: 'ler_dicionario',
  descricao:
    'Lê a estrutura de uma tabela do Sankhya: dicionário (TDDTAB, TDDCAM, TDDINS, TDDOPC), colunas físicas ' +
    '(USER_TAB_COLUMNS) e chave primária. Não lê dados. Use antes de consultar ou gravar.',
  altera: false,
  usaSankhya: true,
  usaNavegador: false,
  schema: z.object({ tabela: nomeTabela, ...CONTROLE }).strict(),
  analisar: (b) => ({ alvos: [{ tabela: String(b.tabela ?? ''), operacao: 'leitura' }] }),
  validarExtra: (p) => {
    const t = normalizarTabela((p as { tabela: string }).tabela);
    return t.valido ? undefined : `Nome de tabela inválido: "${t.original}".`;
  },
  async executar(p, ctx) {
    const e = await lerEstrutura(ctx.gateway, p.tabela);
    if (!e.existe) return { dados: { tabela: e.tabela, existe: false, mensagem: 'Tabela não encontrada no dicionário nem no banco.' } };
    return { dados: e };
  },
});

// ---------------------------------------------------------------- consultar_sql

export const consultarSql = definir({
  nome: 'consultar_sql',
  descricao:
    `Executa UMA consulta de leitura (SELECT ou WITH ... SELECT) no banco do Sankhya de teste. Máximo ${LIMITE_LINHAS} ` +
    `linhas e ${TEMPO_CONSULTA_MS / 1000} s. Recusa ";", comentários, DML, DDL, PL/SQL, pacotes de sistema e ` +
    'colunas sensíveis (SENHA, TOKEN, CHAVE...). Use JOIN explícito (não "(+)") e ROWNUM (não FETCH FIRST). ' +
    'Colunas sensíveis que vierem num SELECT * voltam mascaradas. Tabelas TSI* não podem ser lidas.',
  altera: false,
  usaSankhya: true,
  usaNavegador: false,
  schema: z.object({ sql: z.string().min(1).max(20_000).describe('Um único SELECT, sem ";" e sem comentários.'), ...CONTROLE }).strict(),
  analisar: (b) => {
    const sql = typeof b.sql === 'string' ? b.sql : '';
    const v = validarSelect(sql);
    return {
      sql,
      alvos: v.ok ? v.tabelas.map((t) => ({ tabela: t, operacao: 'leitura' as const })) : [],
      identificadoresLidos: identsSeguros(sql),
    };
  },
  validarExtra: (p) => {
    const v = validarSelect((p as { sql: string }).sql);
    return v.ok ? undefined : v.motivo;
  },
  async executar(p, ctx) {
    const envolvido = `SELECT * FROM (${p.sql}) WHERE ROWNUM <= ${LIMITE_LINHAS + 1}`;
    let r;
    try {
      r = await ctx.gateway.executeQuery(envolvido, AbortSignal.timeout(TEMPO_CONSULTA_MS));
    } catch (e) {
      if (e instanceof ForjaErro && e.codigo === 'SANKHYA_TEMPO_ESGOTADO') {
        throw new ForjaErro('SANKHYA_TEMPO_ESGOTADO', `A consulta passou de ${TEMPO_CONSULTA_MS / 1000} s e foi abandonada.`);
      }
      throw e;
    }
    const secretas = r.columns.map((c) => ehColunaSecreta(c));
    const linhas = r.rows.slice(0, LIMITE_LINHAS).map((l) => l.map((v, i) => (secretas[i] && v !== null ? MASCARA : v)));
    return {
      dados: {
        colunas: r.columns,
        linhas,
        total: linhas.length,
        truncado: r.rows.length > LIMITE_LINHAS || r.truncated,
        colunas_mascaradas: r.columns.filter((_, i) => secretas[i]),
      },
    };
  },
});

// ---------------------------------------------------------------- carregar_registros

const esquemaCarregar = z
  .object({
    entidade: nomeTabela,
    campos: z.array(nomeColuna).min(1).max(100).describe('Campos (colunas) a trazer.'),
    filtro: z
      .object({
        expressao: z.string().min(1).max(2000).describe('Expressão do WHERE, com ? nos valores. Ex.: this.CODPARC = ?'),
        parametros: z
          .array(z.object({ valor: z.union([z.string(), z.number()]), tipo: z.enum(['I', 'S', 'D', 'F']) }))
          .default([])
          .describe('Valores dos ?, em ordem. tipo: I inteiro, S texto, D data, F decimal.'),
      })
      .strict()
      .optional(),
    limite: z.number().int().min(1).max(LIMITE_LINHAS).default(100),
    ...CONTROLE,
  })
  .strict();

export const carregarRegistros = definir({
  nome: 'carregar_registros',
  descricao:
    'Lê registros de uma tabela pelo CRUD do Sankhya (CRUDServiceProvider.loadRecords). "entidade" é o NOME DA ' +
    `TABELA; o servidor resolve a instância. Filtro com marcadores ? e parâmetros tipados. Máximo ${LIMITE_LINHAS} registros.`,
  altera: false,
  usaSankhya: true,
  usaNavegador: false,
  schema: esquemaCarregar,
  analisar: (b) => {
    const f = b.filtro as { expressao?: unknown } | undefined;
    const campos = Array.isArray(b.campos) ? b.campos.map((c) => String(c).toUpperCase()) : [];
    return {
      alvos: [{ tabela: String(b.entidade ?? ''), operacao: 'leitura' }],
      identificadoresLidos: [...campos, ...identsSeguros(f?.expressao)],
    };
  },
  validarExtra: (p) => {
    const q = p as z.output<typeof esquemaCarregar>;
    const t = normalizarTabela(q.entidade);
    if (!t.valido) return `Nome de tabela inválido: "${t.original}".`;
    const secreto = q.campos.find((c) => ehColunaSecreta(c));
    if (secreto) return `O campo ${secreto} tem nome sensível e não pode ser lido.`;
    if (q.filtro) {
      const v = validarFiltro(q.filtro.expressao);
      if (!v.ok) return v.motivo;
      const n = contarMarcadores(q.filtro.expressao);
      if (n !== q.filtro.parametros.length) {
        return `O filtro tem ${n} marcador(es) ? e ${q.filtro.parametros.length} parâmetro(s).`;
      }
    }
    return undefined;
  },
  async executar(p, ctx) {
    const instancia = await resolverInstancia(ctx.gateway, p.entidade, ctx.config.instancias);
    const registros: Record<string, unknown>[] = [];
    let pagina = 0;
    let mais = true;
    while (mais && registros.length < p.limite) {
      const r = await ctx.gateway.loadRecords({
        rootEntity: instancia,
        fields: p.campos,
        ...(p.filtro
          ? { criteria: { expression: p.filtro.expressao, parameters: p.filtro.parametros.map((x) => ({ value: x.valor, type: x.tipo })) } }
          : {}),
        offsetPage: pagina++,
      });
      registros.push(...r.records);
      mais = r.hasMore;
      if (pagina > 200) break;
    }
    const lista = registros.slice(0, p.limite).map((reg) =>
      Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, ehColunaSecreta(k) && v !== null ? MASCARA : v])),
    );
    return { dados: { entidade: instancia, total: lista.length, mais: mais || registros.length > p.limite, registros: lista } };
  },
});
