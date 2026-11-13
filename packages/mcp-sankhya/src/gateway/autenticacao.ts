// Adaptado de db-sankhya/packages/sankhya-client/src/auth.ts
import { ForjaErro } from '../comum/erros.js';

export interface OpcoesToken {
  authUrl: string;
  clientId: string;
  clientSecret: string;
  xToken: string;
  fetch: typeof fetch;
  timeoutMs: number;
  earlyRefreshSeconds?: number;
  now?: () => number;
}

export interface ProvedorToken {
  getToken(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

const MAX_RESPOSTA_AUTH = 64 * 1024;

/**
 * OAuth2 client_credentials no Gateway Sankhya (X-Token no cabeçalho). Token em cache até pouco
 * antes de expirar. Credenciais só saem na requisição de autenticação; erros nunca trazem o corpo.
 */
export function criarProvedorToken(opts: OpcoesToken): ProvedorToken {
  const now = opts.now ?? Date.now;
  const antecedencia = (opts.earlyRefreshSeconds ?? 30) * 1000;
  let cache: { token: string; venceEm: number } | undefined;
  let emVoo: Promise<string> | undefined;

  const buscar = async (): Promise<string> => {
    const body = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'client_credentials',
    });
    let res: Response;
    let texto: string;
    try {
      res = await opts.fetch(opts.authUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'x-token': opts.xToken,
        },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      texto = await lerLimitado(res, MAX_RESPOSTA_AUTH);
    } catch (err) {
      throw erroTransporte(err);
    }
    if (!res.ok) throw erroStatus(res.status);
    const t = parseToken(texto);
    cache = { token: t.accessToken, venceEm: now() + Math.max(0, t.expiresIn * 1000 - antecedencia) };
    return t.accessToken;
  };

  return {
    getToken(signal) {
      if (signal?.aborted) return Promise.reject(new ForjaErro('CANCELADO', 'Chamada cancelada.'));
      if (cache && now() < cache.venceEm) return Promise.resolve(cache.token);
      emVoo ??= buscar().finally(() => {
        emVoo = undefined;
      });
      return emVoo;
    },
    invalidate() {
      cache = undefined;
    },
  };
}

function parseToken(texto: string): { accessToken: string; expiresIn: number } {
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    throw respostaInvalida();
  }
  if (!json || typeof json !== 'object') throw respostaInvalida();
  const { access_token: accessToken, expires_in: expiresIn } = json as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken.length === 0) throw respostaInvalida();
  const s = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) throw respostaInvalida();
  return { accessToken, expiresIn: s };
}

const respostaInvalida = () =>
  new ForjaErro('SANKHYA_RESPOSTA_INVALIDA', 'A autenticação do Gateway devolveu uma resposta inesperada.');

function erroStatus(status: number): ForjaErro {
  if (status === 400 || status === 401 || status === 403) {
    return new ForjaErro('SANKHYA_AUTH', `O Gateway recusou as credenciais (HTTP ${status}).`, { httpStatus: status });
  }
  if (status === 429) return new ForjaErro('SANKHYA_LIMITE', 'O Gateway está limitando requisições (HTTP 429).');
  return new ForjaErro('SANKHYA_INDISPONIVEL', `Falha na autenticação do Gateway (HTTP ${status}).`, { httpStatus: status });
}

/** Falha de rede. O erro original é descartado: o texto pode ecoar dados da requisição. */
export function erroTransporte(err: unknown): ForjaErro {
  if (err instanceof ForjaErro) return err;
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new ForjaErro('SANKHYA_TEMPO_ESGOTADO', 'O Gateway não respondeu a tempo.');
  }
  return new ForjaErro('SANKHYA_INDISPONIVEL', 'Não foi possível falar com o Gateway.');
}

export async function lerLimitado(res: Response, maxBytes: number): Promise<string> {
  const declarado = Number(res.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw grandeDemais();
  }
  if (!res.body) return '';
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await leitor.cancel().catch(() => undefined);
      throw grandeDemais();
    }
    partes.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(partes));
}

const grandeDemais = () => new ForjaErro('SANKHYA_RESPOSTA_INVALIDA', 'Resposta do Gateway grande demais.');
