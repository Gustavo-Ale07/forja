import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { mascarar, mascararTexto } from '../comum/mascara.js';

export type Resultado = 'aceito' | 'recusado' | 'erro';

export interface EventoNovo {
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
}

export interface EventoGravado {
  id: number;
  data_hora: string;
  usuario: string | null;
  perfil: string | null;
  ambiente: string;
  ferramenta: string;
  parametros: string;
  plano_id: string | null;
  passo_id: number | null;
  resultado: Resultado;
  motivo: string;
  antes_json: string | null;
  depois_json: string | null;
  captura_path: string | null;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS chamada_ferramenta (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  data_hora    TEXT    NOT NULL,
  usuario      TEXT,
  perfil       TEXT,
  ambiente     TEXT    NOT NULL,
  ferramenta   TEXT    NOT NULL,
  parametros   TEXT    NOT NULL,
  plano_id     TEXT,
  passo_id     INTEGER,
  resultado    TEXT    NOT NULL CHECK (resultado IN ('aceito','recusado','erro')),
  motivo       TEXT    NOT NULL,
  antes_json   TEXT,
  depois_json  TEXT,
  captura_path TEXT
);
CREATE INDEX IF NOT EXISTS ix_chamada_data  ON chamada_ferramenta(data_hora);
CREATE INDEX IF NOT EXISTS ix_chamada_plano ON chamada_ferramenta(plano_id, passo_id);
CREATE TRIGGER IF NOT EXISTS chamada_sem_update BEFORE UPDATE ON chamada_ferramenta
BEGIN SELECT RAISE(ABORT, 'auditoria só aceita INSERT'); END;
CREATE TRIGGER IF NOT EXISTS chamada_sem_delete BEFORE DELETE ON chamada_ferramenta
BEGIN SELECT RAISE(ABORT, 'auditoria só aceita INSERT'); END;
`;

const LIMITE_JSON = 200_000;

function json(v: unknown): string | null {
  if (v === undefined) return null;
  const texto = JSON.stringify(mascarar(v));
  return texto.length > LIMITE_JSON ? JSON.stringify({ truncado: true, inicio: texto.slice(0, LIMITE_JSON) }) : texto;
}

/**
 * Log de auditoria. A classe só expõe `registrar` (INSERT) e consultas; não há rota de UPDATE
 * ou DELETE, e o banco recusa as duas por gatilho.
 */
export class Auditoria {
  private readonly db: Database.Database;
  private readonly inserir: Database.Statement;

  constructor(arquivo: string) {
    if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    this.db = new Database(arquivo);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(ESQUEMA);
    this.inserir = this.db.prepare(`
      INSERT INTO chamada_ferramenta
        (data_hora, usuario, perfil, ambiente, ferramenta, parametros, plano_id, passo_id,
         resultado, motivo, antes_json, depois_json, captura_path)
      VALUES (@data_hora, @usuario, @perfil, @ambiente, @ferramenta, @parametros, @plano_id, @passo_id,
         @resultado, @motivo, @antes_json, @depois_json, @captura_path)`);
  }

  registrar(ev: EventoNovo, agora = new Date()): number {
    const r = this.inserir.run({
      data_hora: agora.toISOString(),
      usuario: ev.usuario ?? null,
      perfil: ev.perfil ?? null,
      ambiente: ev.ambiente,
      ferramenta: ev.ferramenta,
      parametros: json(ev.parametros) ?? '{}',
      plano_id: ev.planoId ?? null,
      passo_id: ev.passoId ?? null,
      resultado: ev.resultado,
      motivo: mascararTexto(ev.motivo).slice(0, 4000),
      antes_json: json(ev.antes),
      depois_json: json(ev.depois),
      captura_path: ev.capturaPath ?? null,
    });
    return Number(r.lastInsertRowid);
  }

  /** Eventos entre dois instantes (ISO UTC), em ordem. */
  listarEntre(inicioIso: string, fimIso: string): EventoGravado[] {
    return this.db
      .prepare('SELECT * FROM chamada_ferramenta WHERE data_hora >= ? AND data_hora < ? ORDER BY id')
      .all(inicioIso, fimIso) as EventoGravado[];
  }

  /** Um passo conta como executado quando houve execução efetiva aceita. */
  passoExecutado(planoId: string, passoId: number): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 FROM chamada_ferramenta WHERE plano_id = ? AND passo_id = ? AND resultado = 'aceito' AND motivo IN ('executado', 'já existia') LIMIT 1",
      )
      .get(planoId, passoId);
    return r !== undefined;
  }

  /** Só para testes: acesso cru, para provar que UPDATE/DELETE são recusados pelo banco. */
  get _db(): Database.Database {
    return this.db;
  }

  fechar(): void {
    this.db.close();
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
