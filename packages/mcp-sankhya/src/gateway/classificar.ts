// Adaptado de db-sankhya/packages/sankhya-client/src/classify.ts
import { mascararTexto } from '../comum/mascara.js';
import type { EnvelopeGateway } from './tipos.js';

export type Classificacao =
  | { ok: true; envelope: EnvelopeGateway }
  | { ok: false; codigo: string; repetivel: boolean; reautenticar: boolean; ambiguo?: boolean; mensagem: string };

const NAO_AUTORIZADO = /n[aã]o autorizado/i;
const CODIGOS_AUTH_GATEWAY = /\bGTW3\d{3}\b/;

/** Só status "1" é sucesso: o que não for reconhecido é falha, nunca "deu certo". */
export function classificar(httpStatus: number, body: unknown): Classificacao {
  const bruto = mensagemDe(body);
  const msg = limpar(bruto);
  if (httpStatus === 401 || (httpStatus === 403 && CODIGOS_AUTH_GATEWAY.test(bruto))) {
    return falha('SANKHYA_AUTH', false, true, msg || `Gateway HTTP ${httpStatus}`);
  }
  if (httpStatus === 429) return falha('SANKHYA_LIMITE', true, false, msg || 'Limite de requisições');
  if (httpStatus === 504 || httpStatus === 408) return falha('SANKHYA_TEMPO_ESGOTADO', true, false, msg || `HTTP ${httpStatus}`);
  if (httpStatus >= 500) return falha('SANKHYA_INDISPONIVEL', true, false, msg || `HTTP ${httpStatus}`);
  if (httpStatus === 403) return falha('SANKHYA_AUTH', false, false, msg || 'Proibido');
  if (httpStatus < 200 || httpStatus >= 300) return falha('SANKHYA_ERRO_API', false, false, msg || `HTTP ${httpStatus}`);
  if (!isRecord(body) || typeof body.status !== 'string') {
    return falha('SANKHYA_RESPOSTA_INVALIDA', false, false, 'O Gateway respondeu sem envelope.');
  }
  if (body.status === '1') {
    const envelope: EnvelopeGateway = { status: '1' };
    if (typeof body.statusMessage === 'string') envelope.statusMessage = body.statusMessage;
    if (typeof body.transactionId === 'string') envelope.transactionId = body.transactionId;
    if ('responseBody' in body) envelope.responseBody = body.responseBody;
    return { ok: true, envelope };
  }
  if (NAO_AUTORIZADO.test(bruto)) return falha('SANKHYA_NAO_AUTORIZADO', false, false, msg);
  const r = falha('SANKHYA_ERRO_API', false, false, msg || 'O serviço falhou.');
  return body.status !== '0' ? { ...r, ambiguo: true } : r;
}

function falha(codigo: string, repetivel: boolean, reautenticar: boolean, mensagem: string) {
  return { ok: false as const, codigo, repetivel, reautenticar, mensagem };
}

function mensagemDe(body: unknown): string {
  if (!isRecord(body)) return '';
  if (typeof body.statusMessage === 'string') return body.statusMessage;
  const e = body.error;
  if (isRecord(e)) return [e.code, e.message].filter((v) => typeof v === 'string').join(' ');
  if (typeof e === 'string') return e;
  if (typeof body.message === 'string') return body.message;
  return '';
}

function limpar(m: string): string {
  const t = mascararTexto(m).replace(/\s+/g, ' ').trim();
  return t.length > 1000 ? `${t.slice(0, 999)}…` : t;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
