#!/usr/bin/env node
/**
 * forja-aprovar <plano_id> [--passo n]
 *
 * Rodado pelo PRÓPRIO USUÁRIO no terminal (o agente tem deny para este comando). Mostra o plano,
 * pede que o id seja digitado de novo e grava aprovado_por, aprovado_em e o HMAC-SHA256 do plano
 * canônico com FORJA_CHAVE_APROVACAO. O aprovador é o FORJA_USUARIO do .env (o mesmo usuário da
 * Forja que aparece na auditoria), não o usuário do Windows. Com --passo, aprova um passo "com_aprovacao" de plano já assinado.
 */
import { createInterface } from 'node:readline/promises';
import { mensagemSegura } from '../comum/mascara.js';
import { caminhos } from '../config/caminhos.js';
import { lerEnv, TAMANHO_MINIMO_CHAVE } from '../config/index.js';
import { aprovarPasso, assinarPlano, gravarPlano, lerPlano, verificarAssinaturaPlano } from '../porteiro/planos.js';

function argumentos(argv: string[]): { id?: string; passo?: number } {
  const r: { id?: string; passo?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--passo') r.passo = Number(argv[++i]);
    else if (!a.startsWith('--') && !r.id) r.id = a;
    else throw new Error(`Argumento desconhecido: ${a}`);
  }
  return r;
}

async function principal(): Promise<void> {
  const { id, passo } = argumentos(process.argv.slice(2));
  if (!id) throw new Error('Uso: forja-aprovar <plano_id> [--passo n]');
  if (passo !== undefined && (!Number.isInteger(passo) || passo < 1)) throw new Error('--passo precisa ser um inteiro >= 1.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('forja-aprovar precisa ser rodado por uma pessoa num terminal interativo.');
  }

  const c = caminhos();
  const env = lerEnv(c.env);
  const chave = env.FORJA_CHAVE_APROVACAO ?? '';
  if (chave.length < TAMANHO_MINIMO_CHAVE) {
    throw new Error(`FORJA_CHAVE_APROVACAO ausente ou com menos de ${TAMANHO_MINIMO_CHAVE} caracteres no .env.`);
  }
  const plano = lerPlano(c.planos, id);
  if (!plano) throw new Error(`planos/${id}.json não existe.`);
  const aprovadoPor = (env.FORJA_USUARIO ?? '').trim();
  if (!aprovadoPor) throw new Error('FORJA_USUARIO vazio no .env: o aprovador precisa ser o usuário da Forja.');

  const out = process.stdout;
  out.write(`\nPlano ${plano.id}: ${plano.descricao}\n`);
  for (const s of plano.passos) {
    if (passo !== undefined && s.n !== passo) continue;
    out.write(`\n  Passo ${s.n} — ${s.ferramenta}${s.descricao ? ` — ${s.descricao}` : ''}\n`);
    out.write(`${JSON.stringify(s.parametros, null, 2).replace(/^/gm, '    ')}\n`);
  }

  let novo;
  if (passo === undefined) {
    if (plano.assinatura && !verificarAssinaturaPlano(plano, chave)) {
      out.write('\nAviso: este plano já está assinado. Assinar de novo descarta as aprovações de passo.\n');
    }
    novo = assinarPlano(plano, chave, aprovadoPor, new Date());
  } else {
    novo = aprovarPasso(plano, passo, chave, aprovadoPor, new Date());
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const alvo = passo === undefined ? `o plano inteiro` : `o passo ${passo}`;
  const digitado = await rl.question(`\nPara aprovar ${alvo} como "${aprovadoPor}", digite o id do plano (${id}): `);
  rl.close();
  if (digitado.trim() !== id) {
    out.write('Id não confere. Nada foi gravado.\n');
    process.exit(1);
  }
  gravarPlano(c.planos, novo);
  out.write(`Aprovado: ${alvo} de "${id}" por ${aprovadoPor}.\n`);
}

principal().catch((e: unknown) => {
  process.stderr.write(`forja-aprovar: ${mensagemSegura(e)}\n`);
  process.exit(1);
});
