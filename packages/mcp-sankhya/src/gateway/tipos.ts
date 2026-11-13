// Adaptado de db-sankhya/packages/sankhya-client/src/types.ts

export type ModuloGateway = 'mge' | 'mgecom';

export interface RequisicaoGateway {
  module: ModuloGateway;
  serviceName: string;
  requestBody: unknown;
}

/** Envelope JSON de toda resposta de service.sbr. */
export interface EnvelopeGateway {
  /** "1" sucesso, "0" erro; qualquer outro valor é tratado como não-sucesso. */
  status: string;
  statusMessage?: string;
  transactionId?: string;
  responseBody?: unknown;
}

export interface RespostaTransporte {
  httpStatus: number;
  body: unknown;
  retryAfterSeconds?: number;
}

export interface TransporteGateway {
  send(req: RequisicaoGateway, signal?: AbortSignal): Promise<RespostaTransporte>;
}

export type TipoParametroCriterio = 'I' | 'S' | 'D' | 'F';

export interface EntradaLoadRecords {
  rootEntity: string;
  fields: string[];
  criteria?: {
    expression: string;
    parameters: Array<{ value: string | number; type: TipoParametroCriterio }>;
  };
  offsetPage?: number;
}

export interface ResultadoLoadRecords {
  records: Record<string, unknown>[];
  hasMore: boolean;
}

export interface EntradaSave {
  entityName: string;
  fields: string[];
  /** `pk` presente: update; ausente: insert. `values` por nome de campo. */
  records: Array<{ pk?: Record<string, unknown>; values: Record<string, unknown> }>;
}

export interface ResultadoSave {
  results: unknown[][];
  transactionId?: string;
}

export interface ResultadoQuery {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** O que as ferramentas precisam do Gateway. Implementado pelo cliente real e pelo falso. */
export interface Gateway {
  executeQuery(sql: string, signal?: AbortSignal): Promise<ResultadoQuery>;
  loadRecords(input: EntradaLoadRecords, signal?: AbortSignal): Promise<ResultadoLoadRecords>;
  save(input: EntradaSave, signal?: AbortSignal): Promise<ResultadoSave>;
}
