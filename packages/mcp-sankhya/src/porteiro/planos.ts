import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonico, hashParametros, hexIguais, hmac } from '../comum/canonico.js';
import { ForjaErro } from '../comum/erros.js';

export const ID_PLANO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const esquemaPasso = z.object({
  n: z.number().int().positive(),
  ferramenta: z.string().min(1),
  descricao: z.string().optional(),
  parametros: z.record(z.string(), z.unknown()),
  hash_parametros: z.string().optional(),
  aprovacao: z
    .object({
      aprovado_por: z.string().min(1),
      aprovado_em: z.string().min(1),
      assinatura: z.string().min(1),
    })
    .optional(),
});

export const esquemaPlano = z.object({
  id: z.string().regex(ID_PLANO),
  descricao: z.string().default(''),
  criado_por: z.string().optional(),
  criado_em: z.string().optional(),
  passos: z.array(esquemaPasso).min(1),
  aprovado_por: z.string().optional(),
  aprovado_em: z.string().optional(),
  assinatura: z.string().optional(),
});

export type Plano = z.infer<typeof esquemaPlano>;
export type Passo = z.infer<typeof esquemaPasso>;

/** O que a assinatura do plano cobre: id, descrição, quem/quando aprovou e cada passo (ferramenta + hash). */
export function conteudoAssinadoPlano(p: Plano): string {
  return canonico({
    tipo: 'forja-plano-v1',
    id: p.id,
    descricao: p.descricao,
    aprovado_por: p.aprovado_por,
    aprovado_em: p.aprovado_em,
    passos: p.passos.map((s) => ({ n: s.n, ferramenta: s.ferramenta, hash_parametros: hashParametros(s.parametros) })),
  });
}

/** A aprovação de um passo fica presa à assinatura do plano: mudou o plano, cai a aprovação. */
export function conteudoAssinadoPasso(
  p: Plano,
  s: Passo,
  aprovacao: { aprovado_por: string; aprovado_em: string },
): string {
  return canonico({
    tipo: 'forja-passo-v1',
    plano_id: p.id,
    assinatura_plano: p.assinatura,
    n: s.n,
    ferramenta: s.ferramenta,
    hash_parametros: hashParametros(s.parametros),
    aprovado_por: aprovacao.aprovado_por,
    aprovado_em: aprovacao.aprovado_em,
  });
}

/** null = plano assinado e íntegro; string = motivo da recusa. */
export function verificarAssinaturaPlano(p: Plano, chave: string): string | null {
  if (!p.assinatura || !p.aprovado_por || !p.aprovado_em) {
    return `O plano "${p.id}" não está aprovado (sem assinatura). Peça ao responsável para rodar forja-aprovar ${p.id}.`;
  }
  const ns = p.passos.map((s) => s.n);
  if (new Set(ns).size !== ns.length) return `O plano "${p.id}" tem passos com número repetido.`;
  for (const s of p.passos) {
    if (s.hash_parametros && s.hash_parametros !== hashParametros(s.parametros)) {
      return `O passo ${s.n} do plano "${p.id}" foi alterado depois de assinado (hash dos parâmetros não confere).`;
    }
  }
  if (!hexIguais(p.assinatura, hmac(conteudoAssinadoPlano(p), chave))) {
    return `A assinatura do plano "${p.id}" não confere: o plano foi alterado depois de aprovado ou não foi assinado com a chave deste servidor.`;
  }
  return null;
}

export function verificarAprovacaoPasso(p: Plano, s: Passo, chave: string): string | null {
  if (!s.aprovacao) {
    return `O passo ${s.n} do plano "${p.id}" exige aprovação explícita do passo. Peça: forja-aprovar ${p.id} --passo ${s.n}.`;
  }
  const esperado = hmac(conteudoAssinadoPasso(p, s, s.aprovacao), chave);
  if (!hexIguais(s.aprovacao.assinatura, esperado)) {
    return `A aprovação do passo ${s.n} do plano "${p.id}" não confere (passo ou plano alterado depois de aprovado).`;
  }
  return null;
}

export function caminhoPlano(dir: string, id: string): string {
  if (!ID_PLANO.test(id)) throw new ForjaErro('PLANO_ID_INVALIDO', `Id de plano inválido: "${id}".`);
  return path.join(dir, `${id}.json`);
}

/** Lê planos/<id>.json. undefined = não existe. Lança se o JSON for inválido. */
export function lerPlano(dir: string, id: string): Plano | undefined {
  const arq = caminhoPlano(dir, id);
  if (!fs.existsSync(arq)) return undefined;
  let bruto: unknown;
  try {
    bruto = JSON.parse(fs.readFileSync(arq, 'utf8'));
  } catch {
    throw new ForjaErro('PLANO_INVALIDO', `planos/${id}.json não é um JSON válido.`);
  }
  const r = esquemaPlano.safeParse(bruto);
  if (!r.success) throw new ForjaErro('PLANO_INVALIDO', `planos/${id}.json fora do formato: ${z.prettifyError(r.error)}`);
  if (r.data.id !== id) throw new ForjaErro('PLANO_INVALIDO', `planos/${id}.json declara id "${r.data.id}".`);
  return r.data;
}

export function gravarPlano(dir: string, plano: Plano): string {
  const arq = caminhoPlano(dir, plano.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${arq}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(plano, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, arq);
  return arq;
}

/** Assina o plano inteiro (descarta aprovações de passo antigas, que ficariam inválidas). */
export function assinarPlano(p: Plano, chave: string, aprovadoPor: string, agora: Date): Plano {
  const novo: Plano = {
    ...p,
    aprovado_por: aprovadoPor,
    aprovado_em: agora.toISOString(),
    passos: p.passos.map((s) => {
      const { aprovacao: _descartada, ...resto } = s;
      return { ...resto, hash_parametros: hashParametros(s.parametros) };
    }),
  };
  delete novo.assinatura;
  novo.assinatura = hmac(conteudoAssinadoPlano(novo), chave);
  return novo;
}

export function aprovarPasso(p: Plano, n: number, chave: string, aprovadoPor: string, agora: Date): Plano {
  const motivo = verificarAssinaturaPlano(p, chave);
  if (motivo) throw new ForjaErro('PLANO_NAO_ASSINADO', motivo);
  const idx = p.passos.findIndex((s) => s.n === n);
  if (idx === -1) throw new ForjaErro('PASSO_INEXISTENTE', `O plano "${p.id}" não tem passo ${n}.`);
  const passo = p.passos[idx]!;
  const dados = { aprovado_por: aprovadoPor, aprovado_em: agora.toISOString() };
  const assinatura = hmac(conteudoAssinadoPasso(p, passo, dados), chave);
  const passos = [...p.passos];
  passos[idx] = { ...passo, aprovacao: { ...dados, assinatura } };
  return { ...p, passos };
}
