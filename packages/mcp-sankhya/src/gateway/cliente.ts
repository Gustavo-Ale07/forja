// Adaptado de db-sankhya/packages/sankhya-client/src/client.ts (sem circuit breaker, sem removeRecords).
import { ForjaErro } from '../comum/erros.js';
import { criarProvedorToken, type ProvedorToken } from './autenticacao.js';
import { classificar, isRecord } from './classificar.js';
import { criarTransporte } from './transporte.js';
import type {
  EntradaLoadRecords,
  EntradaSave,
  EnvelopeGateway,
  Gateway,
  RequisicaoGateway,
  ResultadoLoadRecords,
  ResultadoQuery,
  ResultadoSave,
  TransporteGateway,
} from './tipos.js';

export interface OpcoesCliente {
  transporte: TransporteGateway;
  tokens: ProvedorToken;
  /** Repetições para chamadas idempotentes (leitura). Escrita nunca repete. */
  repeticoes?: number;
  esperar?: (ms: number) => Promise<void>;
}

const esperarPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fila de um: executeQuery é pesado e compartilhado por todos os usuários do Sankhya. */
class Fila {
  private cauda: Promise<unknown> = Promise.resolve();
  rodar<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.cauda.then(fn, fn);
    this.cauda = p.catch(() => undefined);
    return p;
  }
}

export class ClienteGateway implements Gateway {
  private readonly fila = new Fila();
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpcoesCliente) {
    this.esperar = opts.esperar ?? esperarPadrao;
  }

  /**
   * Uma chamada lógica. Leitura repete falhas transitórias; qualquer chamada reautentica uma vez
   * se o token for recusado antes de ser processado. Escrita é enviada exatamente uma vez: se o
   * resultado for incerto, o erro diz isso e nada é repetido.
   */
  async chamar(req: RequisicaoGateway, idempotente: boolean, signal?: AbortSignal): Promise<EnvelopeGateway> {
    const max = idempotente ? 1 + (this.opts.repeticoes ?? 2) : 1;
    let reautenticou = false;
    for (let tentativa = 1; ; tentativa++) {
      let resp;
      try {
        resp = await this.opts.transporte.send(req, signal);
      } catch (err) {
        const e = err instanceof ForjaErro ? err : new ForjaErro('SANKHYA_INDISPONIVEL', 'Falha ao falar com o Gateway.');
        const antesDeEnviar = e.detalhes?.etapa === 'auth';
        if (!idempotente && !antesDeEnviar) {
          throw new ForjaErro(
            'SANKHYA_RESULTADO_INCERTO',
            'A gravação pode ter chegado ao Sankhya sem resposta. Confira os dados antes de tentar de novo.',
          );
        }
        if (idempotente && tentativa < max && e.codigo !== 'SANKHYA_AUTH') {
          await this.esperar(400 * tentativa);
          continue;
        }
        throw e;
      }
      const c = classificar(resp.httpStatus, resp.body);
      if (c.ok) return c.envelope;
      if (c.reautenticar && !reautenticou) {
        reautenticou = true;
        this.opts.tokens.invalidate();
        tentativa -= 1;
        continue;
      }
      if (c.repetivel && idempotente && tentativa < max) {
        await this.esperar(Math.min((resp.retryAfterSeconds ?? 0) * 1000 || 400 * tentativa, 5000));
        continue;
      }
      if (!idempotente && c.ambiguo) {
        throw new ForjaErro('SANKHYA_RESULTADO_INCERTO', `Resposta ambígua do Gateway: ${c.mensagem}`);
      }
      throw new ForjaErro(c.codigo, `${req.serviceName}: ${c.mensagem}`);
    }
  }

  executeQuery(sql: string, signal?: AbortSignal): Promise<ResultadoQuery> {
    return this.fila.rodar(async () => {
      const env = await this.chamar(
        { module: 'mge', serviceName: 'DbExplorerSP.executeQuery', requestBody: { sql } },
        true,
        signal,
      );
      return mapearQuery(env.responseBody);
    });
  }

  async loadRecords(input: EntradaLoadRecords, signal?: AbortSignal): Promise<ResultadoLoadRecords> {
    const dataSet: Record<string, unknown> = {
      rootEntity: input.rootEntity,
      includePresentationFields: 'N',
      offsetPage: String(input.offsetPage ?? 0),
      entity: { fieldset: { list: input.fields.join(',') } },
    };
    if (input.criteria) {
      dataSet.criteria = {
        expression: { $: input.criteria.expression },
        parameter: input.criteria.parameters.map((p) => ({ $: String(p.value), type: p.type })),
      };
    }
    const env = await this.chamar(
      { module: 'mge', serviceName: 'CRUDServiceProvider.loadRecords', requestBody: { dataSet } },
      true,
      signal,
    );
    return mapearLoadRecords(env.responseBody, input.fields);
  }

  async save(input: EntradaSave, signal?: AbortSignal): Promise<ResultadoSave> {
    const indice = new Map(input.fields.map((f, i) => [f, String(i)]));
    const records = input.records.map((r) => {
      const values: Record<string, unknown> = {};
      for (const [campo, valor] of Object.entries(r.values)) {
        const k = indice.get(campo);
        if (k === undefined) throw new ForjaErro('PARAMETRO_INVALIDO', `Campo ${campo} fora da lista de campos do save.`);
        values[k] = valor;
      }
      return r.pk ? { pk: r.pk, values } : { values };
    });
    const env = await this.chamar(
      {
        module: 'mge',
        serviceName: 'DatasetSP.save',
        requestBody: { entityName: input.entityName, standAlone: false, fields: input.fields, records },
      },
      false,
      signal,
    );
    const corpo = env.responseBody;
    const result = isRecord(corpo) && Array.isArray(corpo.result) ? corpo.result : [];
    const out: ResultadoSave = { results: result.map((l) => (Array.isArray(l) ? (l as unknown[]) : [l])) };
    if (env.transactionId) out.transactionId = env.transactionId;
    return out;
  }
}

const formatoInesperado = (o: string) =>
  new ForjaErro('SANKHYA_RESPOSTA_INVALIDA', `Formato inesperado na resposta de ${o}.`);

export function mapearQuery(corpo: unknown): ResultadoQuery {
  if (!isRecord(corpo) || !Array.isArray(corpo.fieldsMetadata) || !Array.isArray(corpo.rows)) {
    throw formatoInesperado('executeQuery');
  }
  const columns = corpo.fieldsMetadata.map((f, i) => (isRecord(f) && typeof f.name === 'string' ? f.name : `COL${i + 1}`));
  const rows = corpo.rows.map((r) => {
    if (!Array.isArray(r)) throw formatoInesperado('executeQuery');
    return r as unknown[];
  });
  return { columns, rows, truncated: corpo.burstLimit === true || corpo.burstLimit === 'true' };
}

/** loadRecords devolve `entities.entity` (objeto ou lista) com valores em f0..fn como {"$": v}. */
export function mapearLoadRecords(corpo: unknown, pedidos: string[]): ResultadoLoadRecords {
  if (!isRecord(corpo) || !isRecord(corpo.entities)) throw formatoInesperado('loadRecords');
  const ent = corpo.entities;
  const meta = isRecord(ent.metadata) && isRecord(ent.metadata.fields) ? ent.metadata.fields.field : undefined;
  const nomes = (Array.isArray(meta) ? meta : meta ? [meta] : []).map((f, i) =>
    isRecord(f) && typeof f.name === 'string' ? f.name : (pedidos[i] ?? `f${i}`),
  );
  const bruto = ent.entity;
  const lista = bruto === undefined || bruto === null ? [] : Array.isArray(bruto) ? bruto : [bruto];
  const records = lista.map((e) => {
    if (!isRecord(e)) throw formatoInesperado('loadRecords');
    const reg: Record<string, unknown> = {};
    nomes.forEach((nome, i) => {
      const cel = e[`f${i}`];
      reg[nome] = isRecord(cel) && '$' in cel ? cel.$ : (cel ?? null);
    });
    return reg;
  });
  const mais = ent.hasMoreResult;
  return { records, hasMore: mais === true || mais === 'true' };
}

export interface OpcoesClienteReal {
  gatewayUrl: string;
  clientId: string;
  clientSecret: string;
  xToken: string;
  timeoutMs?: number;
}

/** Cliente real. O authUrl segue o db-sankhya: new URL('authenticate', base). */
export function criarClienteReal(o: OpcoesClienteReal): ClienteGateway {
  const base = o.gatewayUrl.endsWith('/') ? o.gatewayUrl : `${o.gatewayUrl}/`;
  const tokens = criarProvedorToken({
    authUrl: new URL('authenticate', base).toString(),
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    xToken: o.xToken,
    fetch: globalThis.fetch,
    timeoutMs: 20_000,
  });
  const transporte = criarTransporte({
    baseUrl: base,
    tokens,
    fetch: globalThis.fetch,
    timeoutMs: o.timeoutMs ?? 30_000,
    maxResponseBytes: 20 * 1024 * 1024,
  });
  return new ClienteGateway({ transporte, tokens });
}
