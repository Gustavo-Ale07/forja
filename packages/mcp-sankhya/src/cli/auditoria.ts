#!/usr/bin/env node
/**
 * forja-auditoria [hoje|AAAA-MM-DD] [--json] — lista os eventos do dia da empresa da sessão
 * (fuso da empresa), lidos do Postgres. Só leitura. Exige pnpm forja-admin login.
 */
import { listarChamadas, lerConfigEmpresa, type ChamadaGravada } from '@forja/banco';
import { hojeNoFuso, intervaloDoDia } from '../auditoria/registro.js';
import { mensagemSegura } from '../comum/mascara.js';
import { abrirSessaoCli } from './sessao-cli.js';

export function formatarEvento(e: ChamadaGravada, fuso: string): string {
  const hora = e.data_hora.toLocaleTimeString('pt-BR', { timeZone: fuso, hour12: false });
  const plano = e.plano_id ? ` plano=${e.plano_id}${e.passo_id ? `#${e.passo_id}` : ''}` : '';
  const parametros = JSON.stringify(e.parametros);
  const linhas = [
    `#${e.id} ${hora} ${e.resultado.toUpperCase().padEnd(8)} ${e.ferramenta} usuario=${e.usuario ?? '-'} perfil=${e.perfil ?? '-'} amb=${e.ambiente}${plano}`,
    `    motivo: ${e.motivo}`,
    `    parametros: ${parametros.length > 300 ? `${parametros.slice(0, 300)}…` : parametros}`,
  ];
  if (e.captura_path) linhas.push(`    captura: ${e.captura_path}`);
  return linhas.join('\n');
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const diaArg = args.find((a) => !a.startsWith('--')) ?? 'hoje';
  const sc = await abrirSessaoCli();
  try {
    const { empresaId } = sc.sessao;
    const { fuso } = await lerConfigEmpresa(sc.app, empresaId);
    const dia = diaArg === 'hoje' ? hojeNoFuso(fuso) : diaArg;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error('Uso: forja-auditoria [hoje|AAAA-MM-DD] [--json]');
    const { inicio, fim } = intervaloDoDia(dia, fuso);
    const eventos = await listarChamadas(sc.app, empresaId, new Date(inicio), new Date(fim));
    if (json) {
      process.stdout.write(`${JSON.stringify(eventos, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Auditoria de ${dia} (${fuso}): ${eventos.length} evento(s)\n\n`);
    for (const e of eventos) process.stdout.write(`${formatarEvento(e, fuso)}\n`);
  } finally {
    await sc.app.destroy();
  }
}

principal().catch((e: unknown) => {
  process.stderr.write(`forja-auditoria: ${mensagemSegura(e)}\n`);
  process.exit(1);
});
