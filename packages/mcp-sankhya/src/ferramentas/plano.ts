import fs from 'node:fs';
import { z } from 'zod';
import { CAMPOS_CONTROLE, hashParametros } from '../comum/canonico.js';
import { ForjaErro } from '../comum/erros.js';
import { mensagemSegura } from '../comum/mascara.js';
import { caminhoPlano, gravarPlano, ID_PLANO, lerPlano, type Plano } from '../porteiro/planos.js';
import { travasFixas, type Analise, type DefinicaoPorteiro } from '../porteiro/porteiro.js';
import { CAMPOS_FORA_DA_TABELA } from './estrutura.js';
import { definir, type Ferramenta } from './tipos.js';

/**
 * propor_plano: ACRÉSCIMO ao pedido original. O agente não pode escrever em planos/ (deny no
 * .claude/settings.json); esta ferramenta grava o rascunho para o usuário assinar com forja-aprovar.
 */
export function criarProporPlano(ferramentas: () => Map<string, Ferramenta>): Ferramenta {
  const esquema = z
    .object({
      id: z.string().regex(ID_PLANO, 'id: letras, números, "-" e "_", até 64'),
      descricao: z.string().min(1).max(2000),
      passos: z
        .array(
          z
            .object({
              ferramenta: z.string().min(1),
              descricao: z.string().max(500).optional(),
              parametros: z.record(z.string(), z.unknown()),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict();

  const analisarPasso = (p: { ferramenta?: unknown; parametros?: unknown }): Analise | undefined => {
    const def = ferramentas().get(String(p.ferramenta));
    if (!def || !p.parametros || typeof p.parametros !== 'object') return undefined;
    try {
      return def.analisar(p.parametros as Record<string, unknown>);
    } catch {
      return undefined;
    }
  };

  return definir({
    nome: 'propor_plano',
    descricao:
      'Grava em planos/<id>.json o RASCUNHO de um plano (lista de passos: ferramenta + parâmetros exatos). Não altera ' +
      'nada no Sankhya. O usuário revisa e assina no próprio terminal com "forja-aprovar <id>"; só então os passos ' +
      'podem rodar, com plano_id e passo_id e exatamente os parâmetros do plano. Não sobrescreve plano assinado. ' +
      'Tabela nova: um passo criar_tabela_ad (só tabela + chave primária) seguido de um passo criar_campo_ad por campo. ' +
      'Uma ação por passo: opções de campo lista em definir_opcoes_lista; "Requerido" em marcar_obrigatorio.',
    altera: false,
    usaSankhya: false,
    usaNavegador: false,
    schema: esquema,
    analisar: (b) => {
      const passos = Array.isArray(b.passos) ? (b.passos as Array<Record<string, unknown>>) : [];
      const an = passos.map(analisarPasso).filter((a): a is Analise => !!a);
      return {
        alvos: an.flatMap((a) => a.alvos),
        registros: Math.max(0, ...an.map((a) => a.registros ?? 0)),
        updateSemFiltro: an.some((a) => a.updateSemFiltro),
        delete: an.some((a) => a.delete),
      };
    },
    validarExtra: (params) => {
      const p = params as z.output<typeof esquema>;
      for (const [i, s] of p.passos.entries()) {
        const n = i + 1;
        const def: DefinicaoPorteiro | undefined = ferramentas().get(s.ferramenta);
        if (!def || s.ferramenta === 'propor_plano') return `Passo ${n}: ferramenta desconhecida "${s.ferramenta}".`;
        const ctrl = Object.keys(s.parametros).filter((k) => (CAMPOS_CONTROLE as readonly string[]).includes(k));
        if (ctrl.length) return `Passo ${n}: não inclua ${ctrl.join(', ')} nos parâmetros do plano.`;
        if (s.ferramenta === 'criar_tabela_ad' && 'campos' in s.parametros) return `Passo ${n}: ${CAMPOS_FORA_DA_TABELA}`;
        const trava = travasFixas(def.analisar(s.parametros));
        if (trava) return `Passo ${n}: ${trava}`;
        const r = def.schema.safeParse(s.parametros);
        if (!r.success) return `Passo ${n}: parâmetros inválidos: ${z.prettifyError(r.error)}`;
        const extra = def.validarExtra?.(r.data);
        if (extra) return `Passo ${n}: ${extra}`;
      }
      return undefined;
    },
    async executar(p, ctx) {
      let existente: Plano | undefined;
      try {
        existente = lerPlano(ctx.diretorioPlanos, p.id);
      } catch (e) {
        if (fs.existsSync(caminhoPlano(ctx.diretorioPlanos, p.id))) {
          throw new ForjaErro('RECUSADO_EXECUCAO', `Já existe planos/${p.id}.json ilegível (${mensagemSegura(e)}). Use outro id.`);
        }
      }
      if (existente?.assinatura) {
        throw new ForjaErro('RECUSADO_EXECUCAO', `O plano "${p.id}" já está assinado e não pode ser sobrescrito. Use outro id.`);
      }
      const plano: Plano = {
        id: p.id,
        descricao: p.descricao,
        criado_por: ctx.usuario,
        criado_em: ctx.agora().toISOString(),
        passos: p.passos.map((s, i) => ({
          n: i + 1,
          ferramenta: s.ferramenta,
          ...(s.descricao ? { descricao: s.descricao } : {}),
          parametros: s.parametros,
          hash_parametros: hashParametros(s.parametros),
        })),
      };
      const arquivo = gravarPlano(ctx.diretorioPlanos, plano);
      const comAprovacao = plano.passos
        .filter((s) => ctx.config.perfis[ctx.config.usuarios[ctx.usuario] ?? '']?.acoes[ctx.ambiente]?.[s.ferramenta] === 'com_aprovacao')
        .map((s) => s.n);
      return {
        depois: plano,
        dados: {
          situacao: 'RASCUNHO GRAVADO — ainda não aprovado.',
          arquivo,
          passos: plano.passos.map((s) => ({ n: s.n, ferramenta: s.ferramenta, descricao: s.descricao })),
          para_aprovar: `O usuário deve rodar no próprio terminal: forja-aprovar ${p.id}`,
          passos_que_exigem_aprovacao_extra: comAprovacao.map((n) => `forja-aprovar ${p.id} --passo ${n}`),
          como_executar: 'Depois de assinado, chame cada ferramenta com plano_id, passo_id e exatamente os parâmetros do passo.',
        },
      };
    },
  });
}
