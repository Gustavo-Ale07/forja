// Adaptado de db-sankhya/packages/sankhya-client/src/transport.ts
import { ForjaErro } from '../comum/erros.js';
import { erroTransporte, lerLimitado, type ProvedorToken } from './autenticacao.js';
import type { RequisicaoGateway, RespostaTransporte, TransporteGateway } from './tipos.js';

export interface OpcoesTransporte {
  baseUrl: string;
  tokens: ProvedorToken;
  fetch: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
}

const NOME_SERVICO = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;

export function urlServico(baseUrl: string, req: Pick<RequisicaoGateway, 'module' | 'serviceName'>): URL {
  if (!NOME_SERVICO.test(req.serviceName)) throw new Error('Nome de serviço inválido');
  if (req.module !== 'mge' && req.module !== 'mgecom') throw new Error('Módulo inválido');
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(`gateway/v1/${req.module}/service.sbr`, base);
  url.searchParams.set('serviceName', req.serviceName);
  url.searchParams.set('outputType', 'json');
  return url;
}

export function criarTransporte(opts: OpcoesTransporte): TransporteGateway {
  return {
    async send(req, signal) {
      const url = urlServico(opts.baseUrl, req);
      let token: string;
      try {
        token = await opts.tokens.getToken(signal);
      } catch (err) {
        const e = err instanceof ForjaErro ? err : erroTransporte(err);
        throw new ForjaErro(e.codigo, e.message, { ...e.detalhes, etapa: 'auth' });
      }
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const sinal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await opts.fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
            accept: 'application/json',
          },
          body: JSON.stringify({ serviceName: req.serviceName, requestBody: req.requestBody }),
          redirect: 'error',
          signal: sinal,
        });
        const texto = await lerLimitado(res, opts.maxResponseBytes);
        const out: RespostaTransporte = { httpStatus: res.status, body: parseJson(texto) };
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) out.retryAfterSeconds = Math.min(ra, 300);
        return out;
      } catch (err) {
        throw erroTransporte(err);
      }
    },
  };
}

function parseJson(texto: string): unknown {
  if (!texto) return undefined;
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return undefined;
  }
}
