import { z } from 'zod';
import { canonico, hashParametros, sha256 } from '../comum/canonico.js';
import { ForjaErro } from '../comum/erros.js';
import { ehColunaSecreta } from '../comum/mascara.js';
import type { Gateway } from '../gateway/tipos.js';
import { normalizarTabela } from '../porteiro/tabelas.js';
import { comoObjetos, resolverInstancia, SQL } from '../sankhya/dicionario.js';
import { CONTROLE, definir } from './tipos.js';

const valor = z.union([z.string().max(4000), z.number(), z.null()]);
const nome = z.string().regex(/^[A-Za-z][A-Za-z0-9_$#]{0,29}$/, 'nome de campo inválido');

const esquemaGravar = z
  .object({
    entidade: z.string().min(1).max(40).describe('Nome da TABELA (ex.: AD_MINHATABELA).'),
    registros: z
      .array(
        z
          .object({
            chave: z
              .record(nome, z.union([z.string().min(1), z.number()]))
              .optional()
              .describe('Chave primária COMPLETA do registro a alterar. Ausente = inclusão.'),
            valores: z.record(nome, valor).describe('Campos e valores a gravar.'),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    token_confirmacao: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('Token devolvido pela prévia. Sem ele, a chamada só mostra a prévia e não grava nada.'),
    ...CONTROLE,
  })
  .strict();

type ParamsGravar = z.output<typeof esquemaGravar>;

const recusar = (m: string) => new ForjaErro('RECUSADO_EXECUCAO', m);
const maius = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toUpperCase(), v]));

interface Plano {
  instancia: string;
  pk: string[];
  campos: string[];
  registros: Array<{ chave?: Record<string, string | number>; valores: Record<string, unknown> }>;
}

async function prepararGravacao(gw: Gateway, p: ParamsGravar, instancias: Record<string, string>): Promise<Plano> {
  const tabela = normalizarTabela(p.entidade).nome;
  const instancia = await resolverInstancia(gw, tabela, instancias);
  const pk = comoObjetos(await gw.executeQuery(SQL.chavePrimaria(tabela))).map((l) => String(l.COLUMN_NAME).toUpperCase());
  if (pk.length === 0) throw recusar(`Não encontrei a chave primária de ${tabela}; sem ela não há gravação segura.`);
  const registros = p.registros.map((r, i) => {
    const valores = maius(r.valores);
    const chave = r.chave ? (maius(r.chave) as Record<string, string | number>) : undefined;
    const naChave = Object.keys(valores).filter((c) => pk.includes(c));
    if (naChave.length) {
      throw recusar(`Registro ${i + 1}: a chave primária (${naChave.join(', ')}) não pode ir em "valores" (inclusão usa auto numeração; alteração usa "chave").`);
    }
    if (chave) {
      const k = Object.keys(chave).sort();
      if (k.length !== pk.length || pk.some((c) => !k.includes(c))) {
        throw recusar(`Registro ${i + 1}: chave incompleta ou errada. A chave primária de ${tabela} é (${pk.join(', ')}).`);
      }
    }
    if (Object.keys(valores).length === 0) throw recusar(`Registro ${i + 1}: nada para gravar.`);
    return chave ? { chave, valores } : { valores };
  });
  const campos = [...new Set(registros.flatMap((r) => Object.keys(r.valores)))];
  return { instancia, pk, campos, registros };
}

/** Estado atual dos registros que serão alterados (inclusões não têm "antes"). */
async function lerAntes(gw: Gateway, pl: Plano): Promise<Array<Record<string, unknown> | null>> {
  const out: Array<Record<string, unknown> | null> = [];
  for (const [i, r] of pl.registros.entries()) {
    if (!r.chave) {
      out.push(null);
      continue;
    }
    const res = await gw.loadRecords({
      rootEntity: pl.instancia,
      fields: [...pl.pk, ...pl.campos],
      criteria: {
        expression: pl.pk.map((c) => `this.${c} = ?`).join(' AND '),
        parameters: pl.pk.map((c) => {
          const v = r.chave![c]!;
          return { value: v, type: typeof v === 'number' ? (Number.isInteger(v) ? 'I' : 'F') : 'S' };
        }),
      },
    });
    if (res.records.length !== 1) {
      throw recusar(`Registro ${i + 1}: a chave não identifica exatamente um registro (achei ${res.records.length}).`);
    }
    out.push(res.records[0]!);
  }
  return out;
}

export const gravarRegistros = definir({
  nome: 'gravar_registros',
  descricao:
    'Inclui ou altera registros (DatasetSP.save). Em duas chamadas: a 1ª devolve a PRÉVIA (antes/depois) e um ' +
    'token_confirmacao, sem gravar nada; a 2ª, com os MESMOS parâmetros + token_confirmacao, grava. Exige plano ' +
    'aprovado (plano_id, passo_id). Por padrão só tabelas AD_. Alteração exige a chave primária completa. ' +
    'Nunca exclui registros.',
  altera: true,
  usaSankhya: true,
  usaNavegador: false,
  schema: esquemaGravar,
  analisar: (b) => {
    const regs = Array.isArray(b.registros) ? (b.registros as Array<Record<string, unknown>>) : [];
    const semFiltro = regs.some((r) => {
      if (!r || typeof r !== 'object' || !('chave' in r)) return false;
      const c = r.chave;
      return !c || typeof c !== 'object' || Object.keys(c).length === 0 || Object.values(c).some((v) => v === null || v === '');
    });
    return {
      alvos: [{ tabela: String(b.entidade ?? ''), operacao: 'gravacao' }],
      registros: regs.length,
      updateSemFiltro: semFiltro,
    };
  },
  validarExtra: (p) => {
    const q = p as ParamsGravar;
    const t = normalizarTabela(q.entidade);
    if (!t.valido) return `Nome de tabela inválido: "${t.original}".`;
    for (const r of q.registros) {
      const sens = [...Object.keys(r.valores), ...Object.keys(r.chave ?? {})].find((c) => ehColunaSecreta(c));
      if (sens) return `O campo ${sens} tem nome sensível e não pode ser gravado pela Forja.`;
    }
    return undefined;
  },
  async executar(p, ctx) {
    const pl = await prepararGravacao(ctx.gateway, p, ctx.config.instancias);
    const antes = await lerAntes(ctx.gateway, pl);
    const depoisProposto = pl.registros.map((r, i) => ({ ...(antes[i] ?? {}), ...(r.chave ?? {}), ...r.valores }));
    const hashAntes = sha256(canonico(antes));
    const esperado = {
      hashParametros: hashParametros(p as unknown as Record<string, unknown>),
      usuario: ctx.usuario,
      planoId: ctx.planoId,
      passoId: ctx.passoId,
    };

    if (!p.token_confirmacao) {
      const { token, expiraEm } = ctx.confirmacoes.criar({ ...esperado, hashAntes }, ctx.agora().getTime());
      return {
        motivo: 'previa',
        antes,
        depois: depoisProposto,
        dados: {
          situacao: 'PRÉVIA — nada foi gravado.',
          entidade: pl.instancia,
          inclusoes: pl.registros.filter((r) => !r.chave).length,
          alteracoes: pl.registros.filter((r) => r.chave).length,
          antes,
          depois: depoisProposto,
          // Nome sem "token": a máscara de saída esconde chaves com TOKEN no nome.
          codigo_confirmacao: token,
          expira_em: expiraEm.toISOString(),
          proximo_passo: 'Para gravar, repita a chamada com os mesmos parâmetros + token_confirmacao = codigo_confirmacao.',
        },
      };
    }

    const c = ctx.confirmacoes.consumir(p.token_confirmacao, esperado, ctx.agora().getTime());
    if (!c.ok) throw recusar(c.motivo);
    if (c.hashAntes !== hashAntes) {
      throw recusar('Os registros mudaram no Sankhya desde a prévia. Nada foi gravado; peça nova prévia.');
    }
    const res = await ctx.gateway.save({
      entityName: pl.instancia,
      fields: pl.campos,
      records: pl.registros.map((r) => (r.chave ? { pk: r.chave, values: r.valores } : { values: r.valores })),
    });
    const depoisAlteracoes = await lerAntes(ctx.gateway, { ...pl, registros: pl.registros.filter((r) => r.chave) });
    return {
      antes,
      depois: { alterados: depoisAlteracoes, resposta_save: res.results },
      dados: {
        situacao: 'GRAVADO',
        entidade: pl.instancia,
        transacao: res.transactionId,
        resposta_save: res.results,
        alterados_relidos: depoisAlteracoes,
      },
    };
  },
});
