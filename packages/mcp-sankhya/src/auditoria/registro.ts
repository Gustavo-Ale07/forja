import { passoExecutado, registrarChamada, reservarPasso, type ChamadaNova, type Db, type ResultadoReserva } from '@forja/banco';
import { mascarar, mascararTexto } from '../comum/mascara.js';

export type Resultado = 'aceito' | 'recusado' | 'erro';

export interface EventoNovo {
  usuarioId?: string | undefined;
  usuario?: string | undefined;
  perfil?: string | undefined;
  ambiente: string;
  ferramenta: string;
  parametros: unknown;
  planoId?: string | undefined;
  passoId?: number | undefined;
  resultado: Resultado;
  /** 'executado' para execução efetiva; 'já existia' quando o alvo já estava igual (passo cumprido sem
   * alterar nada); 'previa' para prévia; o motivo da recusa/erro nos demais. */
  motivo: string;
  antes?: unknown;
  depois?: unknown;
  capturaPath?: string | undefined;
  /** Desfecho da reserva criada por `reservar`. */
  reservaId?: string | undefined;
}

/**
 * Log de auditoria. Só existe `registrar` (INSERT) e a consulta de passo executado; não há rota
 * de UPDATE ou DELETE, e o Postgres recusa as duas (e o TRUNCATE) por gatilho.
 */
export interface Auditoria {
  registrar(ev: EventoNovo): Promise<void>;
  /** Um passo conta como executado quando houve execução efetiva aceita. */
  passoExecutado(planoId: string, passoId: number): Promise<boolean>;
  /**
   * Reserva o passo ANTES de executar (linha "em_execucao"). Recusa se já foi executado ou se há
   * reserva sem desfecho. O desfecho vai em `registrar({ ..., reservaId })`.
   */
  reservar(ev: Omit<EventoNovo, 'resultado' | 'motivo'>): Promise<ResultadoReserva>;
}

const LIMITE_JSON = 200_000;

function json(v: unknown): string | null {
  if (v === undefined) return null;
  const texto = JSON.stringify(mascarar(v));
  return texto.length > LIMITE_JSON ? JSON.stringify({ truncado: true, inicio: texto.slice(0, LIMITE_JSON) }) : texto;
}

/** Evento → linha da tabela, com segredos mascarados e JSON limitado. */
export function linhaAuditoria(ev: EventoNovo): ChamadaNova {
  return {
    usuarioId: ev.usuarioId,
    usuario: ev.usuario,
    perfil: ev.perfil,
    ambiente: ev.ambiente,
    ferramenta: ev.ferramenta,
    parametrosJson: json(ev.parametros ?? {}) ?? '{}',
    planoId: ev.planoId,
    passoId: ev.passoId,
    resultado: ev.resultado,
    motivo: mascararTexto(ev.motivo).slice(0, 4000),
    antesJson: json(ev.antes),
    depoisJson: json(ev.depois),
    capturaPath: ev.capturaPath,
    reservaId: ev.reservaId,
  };
}

/** Auditoria da empresa no Postgres (tabela chamada_ferramenta, sob RLS). */
export class AuditoriaPostgres implements Auditoria {
  constructor(
    private readonly app: Db,
    private readonly empresaId: string,
    private readonly agora: () => Date = () => new Date(),
  ) {}

  async registrar(ev: EventoNovo): Promise<void> {
    await registrarChamada(this.app, this.empresaId, linhaAuditoria(ev), this.agora());
  }

  passoExecutado(planoId: string, passoId: number): Promise<boolean> {
    return passoExecutado(this.app, this.empresaId, planoId, passoId);
  }

  reservar(ev: Omit<EventoNovo, 'resultado' | 'motivo'>): Promise<ResultadoReserva> {
    return reservarPasso(this.app, this.empresaId, linhaAuditoria({ ...ev, resultado: 'aceito', motivo: '' }), this.agora());
  }
}

/** [início, fim) do dia local `dia` (AAAA-MM-DD) no fuso, em ISO UTC. */
export function intervaloDoDia(dia: string, fuso: string): { inicio: string; fim: string } {
  const [a, m, d] = dia.split('-').map(Number) as [number, number, number];
  const inicio = instanteLocal(a, m, d, fuso);
  const fim = instanteLocal(a, m, d + 1, fuso);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

/** Instante UTC da meia-noite local de a-m-d no fuso. */
function instanteLocal(a: number, m: number, d: number, fuso: string): Date {
  const palpite = new Date(Date.UTC(a, m - 1, d));
  const deslocamento = deslocamentoMin(palpite, fuso);
  const ajustado = new Date(palpite.getTime() - deslocamento * 60_000);
  const segundo = deslocamentoMin(ajustado, fuso);
  return segundo === deslocamento ? ajustado : new Date(palpite.getTime() - segundo * 60_000);
}

function deslocamentoMin(data: Date, fuso: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(data);
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const comoUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return Math.round((comoUtc - data.getTime()) / 60_000);
}

export function hojeNoFuso(fuso: string, agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}
