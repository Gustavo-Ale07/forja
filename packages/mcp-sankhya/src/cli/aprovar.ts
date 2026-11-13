#!/usr/bin/env node
/**
 * forja-aprovar <plano_id> [--passo n] [--conferir feito|nao-feito]
 *
 * Rodado pelo PRÓPRIO USUÁRIO no terminal (o agente tem deny para este comando). Exige a sessão
 * da Forja (pnpm forja-admin login): o aprovador é o usuário dessa sessão. Mostra o plano, pede o
 * id de novo e um código TOTP novo do aplicativo autenticador; só então grava aprovado_por,
 * aprovado_em e o HMAC-SHA256 do plano canônico com FORJA_CHAVE_APROVACAO. Com --passo, aprova um
 * passo "com_aprovacao" de plano já assinado (também com TOTP).
 *
 * Com --passo N --conferir feito|nao-feito, fecha uma reserva "em execução" que ficou sem desfecho
 * (o servidor recusa esse passo até a conferência manual). Também com TOTP.
 */
import { mensagemSegura } from '../comum/mascara.js';
import { TAMANHO_MINIMO_CHAVE } from '../config/index.js';
import { aprovar, conferir } from './aprovacao.js';
import { perguntar } from './pergunta.js';
import { abrirSessaoCli } from './sessao-cli.js';

type Args = { id?: string; passo?: number; conferir?: string };
function argumentos(argv: string[]): Args {
  const r: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--passo') r.passo = Number(argv[++i]);
    else if (a === '--conferir') r.conferir = argv[++i] ?? '';
    else if (!a.startsWith('--') && !r.id) r.id = a;
    else throw new Error(`Argumento desconhecido: ${a}`);
  }
  return r;
}

async function principal(): Promise<void> {
  const { id, passo, conferir: desfecho } = argumentos(process.argv.slice(2));
  if (!id) throw new Error('Uso: forja-aprovar <plano_id> [--passo n] [--conferir feito|nao-feito]');
  if (passo !== undefined && (!Number.isInteger(passo) || passo < 1)) throw new Error('--passo precisa ser um inteiro >= 1.');
  if (desfecho !== undefined) {
    if (desfecho !== 'feito' && desfecho !== 'nao-feito') throw new Error('--conferir aceita "feito" ou "nao-feito".');
    if (passo === undefined) throw new Error('--conferir exige --passo n.');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('forja-aprovar precisa ser rodado por uma pessoa num terminal interativo.');
  }

  const sc = await abrirSessaoCli({ comCofre: true });
  try {
    if (desfecho !== undefined) {
      const c = await conferir({
        app: sc.app,
        cofre: sc.cofre!,
        sessao: sc.sessao,
        diretorioPlanos: sc.caminhos.planos,
        id,
        passo: passo!,
        desfecho: desfecho as 'feito' | 'nao-feito',
        confirmarId: (q) => perguntar(q),
        pedirCodigo: (q) => perguntar(q),
        escrever: (t) => process.stdout.write(t),
      });
      if (!c.conferido) {
        process.stdout.write(`${c.motivo}
`);
        process.exitCode = 1;
      }
      return;
    }
    const chave = sc.env.FORJA_CHAVE_APROVACAO ?? '';
    if (chave.length < TAMANHO_MINIMO_CHAVE) {
      throw new Error(`FORJA_CHAVE_APROVACAO ausente ou com menos de ${TAMANHO_MINIMO_CHAVE} caracteres no .env.`);
    }
    const r = await aprovar({
      app: sc.app,
      cofre: sc.cofre!,
      sessao: sc.sessao,
      chave,
      diretorioPlanos: sc.caminhos.planos,
      id,
      passo,
      confirmarId: (q) => perguntar(q),
      pedirCodigo: (q) => perguntar(q),
      escrever: (t) => process.stdout.write(t),
    });
    if (!r.aprovado) {
      process.stdout.write(`${r.motivo}\n`);
      process.exitCode = 1;
    }
  } finally {
    await sc.app.destroy();
  }
}

principal().catch((e: unknown) => {
  process.stderr.write(`forja-aprovar: ${mensagemSegura(e)}\n`);
  process.exit(1);
});
