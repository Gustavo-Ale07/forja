#!/usr/bin/env node
/** forja-auditoria [hoje|AAAA-MM-DD] [--json] — lista os eventos do dia (fuso do config). Só leitura. */
import fs from 'node:fs';
import { Auditoria, hojeNoFuso, intervaloDoDia, type EventoGravado } from '../auditoria/registro.js';
import { mensagemSegura } from '../comum/mascara.js';
import { caminhos } from '../config/caminhos.js';
import { lerConfigArquivo } from '../config/index.js';

export function formatarEvento(e: EventoGravado, fuso: string): string {
  const hora = new Date(e.data_hora).toLocaleTimeString('pt-BR', { timeZone: fuso, hour12: false });
  const plano = e.plano_id ? ` plano=${e.plano_id}${e.passo_id ? `#${e.passo_id}` : ''}` : '';
  const linhas = [
    `#${e.id} ${hora} ${e.resultado.toUpperCase().padEnd(8)} ${e.ferramenta} usuario=${e.usuario ?? '-'} perfil=${e.perfil ?? '-'} amb=${e.ambiente}${plano}`,
    `    motivo: ${e.motivo}`,
    `    parametros: ${e.parametros.length > 300 ? `${e.parametros.slice(0, 300)}…` : e.parametros}`,
  ];
  if (e.captura_path) linhas.push(`    captura: ${e.captura_path}`);
  return linhas.join('\n');
}

function principal(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const diaArg = args.find((a) => !a.startsWith('--')) ?? 'hoje';
  const c = caminhos();
  let fuso = 'America/Sao_Paulo';
  try {
    fuso = lerConfigArquivo(c.config, c.configLocal).fuso;
  } catch {
    /* sem config: usa o padrão */
  }
  const dia = diaArg === 'hoje' ? hojeNoFuso(fuso) : diaArg;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error('Uso: forja-auditoria [hoje|AAAA-MM-DD] [--json]');
  if (!fs.existsSync(c.bancoAuditoria)) {
    process.stdout.write('Nenhuma auditoria registrada ainda.\n');
    return;
  }
  const aud = new Auditoria(c.bancoAuditoria);
  try {
    const { inicio, fim } = intervaloDoDia(dia, fuso);
    const eventos = aud.listarEntre(inicio, fim);
    if (json) {
      process.stdout.write(`${JSON.stringify(eventos, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Auditoria de ${dia} (${fuso}): ${eventos.length} evento(s)\n\n`);
    for (const e of eventos) process.stdout.write(`${formatarEvento(e, fuso)}\n`);
  } finally {
    aud.fechar();
  }
}

try {
  principal();
} catch (e) {
  process.stderr.write(`forja-auditoria: ${mensagemSegura(e)}\n`);
  process.exit(1);
}
