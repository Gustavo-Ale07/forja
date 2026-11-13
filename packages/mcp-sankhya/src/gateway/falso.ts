import { ForjaErro } from '../comum/erros.js';
import { TIPOS_CAMPO, type TipoCampo } from '../sankhya/tipos-campo.js';
import type {
  EntradaLoadRecords,
  EntradaSave,
  Gateway,
  ResultadoLoadRecords,
  ResultadoQuery,
  ResultadoSave,
} from './tipos.js';

/**
 * Gateway falso para testes: uma base Sankhya em memória que responde às consultas que o servidor
 * emite (dicionário, USER_TAB_COLUMNS, chave primária) e implementa loadRecords/save. Toda chamada
 * fica em `chamadas`, para os testes provarem que uma recusa não chegou "ao Sankhya".
 */

export interface ColunaFalsa {
  nome: string;
  dataType: string;
  length: number;
  precision: number | null;
  nullable: 'Y' | 'N';
}

export interface TabelaFalsa {
  nome: string;
  descricao: string;
  tipoNumeracao: string | null;
  instancias: string[];
  campos: Array<{ nucampo: number; nome: string; descr: string; tipcampo: string }>;
  colunas: ColunaFalsa[];
  opcoes: Array<{ campo: string; valor: string; opcao: string }>;
  /** TDDPCO (atributos chave/valor por campo), ex.: requerido = 'S'. */
  atributos: Array<{ campo: string; nome: string; valor: string }>;
  pk: string[];
  registros: Array<Record<string, unknown>>;
  proximoId: number;
}

let nucampoGlobal = 1000;

export class BaseFalsa {
  usuario = 'USUARIO_TESTE';
  readonly tabelas = new Map<string, TabelaFalsa>();

  criarTabela(nome: string, descricao: string, pk = 'ID', instancia?: string): TabelaFalsa {
    if (this.tabelas.has(nome)) throw new Error(`tabela ${nome} já existe`);
    const t: TabelaFalsa = {
      nome,
      descricao,
      tipoNumeracao: 'A',
      instancias: [instancia ?? nome.replace(/^AD_/, '').toLowerCase()],
      campos: [],
      colunas: [],
      opcoes: [],
      atributos: [],
      pk: [pk],
      registros: [],
      proximoId: 1,
    };
    this.tabelas.set(nome, t);
    this.criarCampo(nome, pk, pk, 'inteiro');
    t.colunas[0]!.nullable = 'N';
    return t;
  }

  private tabela(tabela: string): TabelaFalsa {
    const t = this.tabelas.get(tabela);
    if (!t) throw new Error(`tabela ${tabela} não existe`);
    return t;
  }

  criarCampo(tabela: string, campo: string, descr: string, tipo: TipoCampo): void {
    const t = this.tabela(tabela);
    const def = TIPOS_CAMPO[tipo];
    t.campos.push({ nucampo: nucampoGlobal++, nome: campo, descr, tipcampo: def.tipcampo });
    const numerico = def.dataType === 'NUMBER' || def.dataType === 'FLOAT';
    t.colunas.push({
      nome: campo,
      dataType: def.dataType,
      length: numerico ? 22 : def.tamanho,
      precision: numerico ? def.tamanho : null,
      nullable: 'Y',
    });
  }

  incluirOpcoes(tabela: string, campo: string, opcoes: Array<{ valor: string; descricao: string }>): void {
    const t = this.tabela(tabela);
    for (const o of opcoes) t.opcoes.push({ campo, valor: o.valor, opcao: o.descricao });
  }

  marcarRequerido(tabela: string, campo: string): void {
    const t = this.tabela(tabela);
    t.atributos = t.atributos.filter((a) => !(a.campo === campo && a.nome === 'requerido'));
    t.atributos.push({ campo, nome: 'requerido', valor: 'S' });
  }

  porInstancia(instancia: string): TabelaFalsa | undefined {
    return [...this.tabelas.values()].find((t) => t.instancias.includes(instancia));
  }
}

export interface ChamadaFalsa {
  servico: string;
  detalhe: unknown;
}

const q = (columns: string[], rows: unknown[][]): ResultadoQuery => ({ columns, rows, truncated: false });

export class GatewayFalso implements Gateway {
  readonly chamadas: ChamadaFalsa[] = [];
  /** Resposta para SQL não reconhecido (consultar_sql dos testes). */
  responderSql: (sql: string) => ResultadoQuery = () => q(['RESULTADO'], []);
  /** Força falha no save (ex.: "Não autorizado"). */
  falharSave: string | undefined;

  constructor(readonly base = new BaseFalsa()) {}

  async executeQuery(sql: string): Promise<ResultadoQuery> {
    this.chamadas.push({ servico: 'DbExplorerSP.executeQuery', detalhe: sql });
    const b = this.base;
    let m: RegExpMatchArray | null;
    if (sql === 'SELECT USER AS USUARIO FROM DUAL') return q(['USUARIO'], [[b.usuario]]);
    if ((m = sql.match(/^SELECT NOMETAB, DESCRTAB, TIPONUMERACAO FROM TDDTAB WHERE NOMETAB = '(\w+)'$/))) {
      const t = b.tabelas.get(m[1]!);
      return q(['NOMETAB', 'DESCRTAB', 'TIPONUMERACAO'], t ? [[t.nome, t.descricao, t.tipoNumeracao]] : []);
    }
    if ((m = sql.match(/FROM TDDCAM WHERE NOMETAB = '(\w+)' ORDER BY NUCAMPO$/))) {
      const t = b.tabelas.get(m[1]!);
      return q(['NUCAMPO', 'NOMECAMPO', 'DESCRCAMPO', 'TIPCAMPO'], (t?.campos ?? []).map((c) => [c.nucampo, c.nome, c.descr, c.tipcampo]));
    }
    if ((m = sql.match(/FROM USER_TAB_COLUMNS WHERE TABLE_NAME = '(\w+)'/))) {
      const t = b.tabelas.get(m[1]!);
      return q(
        ['COLUMN_NAME', 'DATA_TYPE', 'DATA_LENGTH', 'DATA_PRECISION', 'NULLABLE'],
        (t?.colunas ?? []).map((c) => [c.nome, c.dataType, c.length, c.precision, c.nullable]),
      );
    }
    if ((m = sql.match(/^SELECT NOMEINSTANCIA FROM TDDINS WHERE NOMETAB = '(\w+)'$/))) {
      const t = b.tabelas.get(m[1]!);
      return q(['NOMEINSTANCIA'], (t?.instancias ?? []).map((i) => [i]));
    }
    if ((m = sql.match(/FROM TDDOPC O JOIN TDDCAM C .* WHERE C.NOMETAB = '(\w+)'/))) {
      const t = b.tabelas.get(m[1]!);
      return q(['NOMECAMPO', 'VALOR', 'OPCAO'], (t?.opcoes ?? []).map((o) => [o.campo, o.valor, o.opcao]));
    }
    if ((m = sql.match(/FROM TDDPCO P JOIN TDDCAM C .* WHERE C.NOMETAB = '(\w+)'/))) {
      const t = b.tabelas.get(m[1]!);
      return q(['NOMECAMPO', 'NOME', 'VALOR'], (t?.atributos ?? []).map((a) => [a.campo, a.nome, a.valor]));
    }
    if ((m = sql.match(/FROM USER_CONSTRAINTS UC .* WHERE UC.TABLE_NAME = '(\w+)' AND UC.CONSTRAINT_TYPE = 'P'/))) {
      const t = b.tabelas.get(m[1]!);
      return q(['COLUMN_NAME'], (t?.pk ?? []).map((p) => [p]));
    }
    return this.responderSql(sql);
  }

  async loadRecords(input: EntradaLoadRecords): Promise<ResultadoLoadRecords> {
    this.chamadas.push({ servico: 'CRUDServiceProvider.loadRecords', detalhe: input });
    const t = this.base.porInstancia(input.rootEntity);
    if (!t) throw new ForjaErro('SANKHYA_ERRO_API', `Entidade ${input.rootEntity} não encontrada.`);
    let regs = t.registros;
    if (input.criteria) {
      const partes = input.criteria.expression.split(/\s+AND\s+/i);
      const filtros = partes.map((p, i) => {
        const m = p.trim().match(/^(?:this\.)?(\w+)\s*=\s*\?$/i);
        if (!m) throw new Error(`filtro não suportado pelo falso: ${p}`);
        return { campo: m[1]!.toUpperCase(), valor: input.criteria!.parameters[i]?.value };
      });
      regs = regs.filter((r) => filtros.every((f) => String(r[f.campo]) === String(f.valor)));
    }
    const pagina = input.offsetPage ?? 0;
    const tam = 50;
    const fatia = regs.slice(pagina * tam, pagina * tam + tam);
    return {
      records: fatia.map((r) => Object.fromEntries(input.fields.map((f) => [f, r[f] ?? null]))),
      hasMore: regs.length > (pagina + 1) * tam,
    };
  }

  async save(input: EntradaSave): Promise<ResultadoSave> {
    this.chamadas.push({ servico: 'DatasetSP.save', detalhe: input });
    if (this.falharSave) throw new ForjaErro('SANKHYA_NAO_AUTORIZADO', this.falharSave);
    const t = this.base.porInstancia(input.entityName);
    if (!t) throw new ForjaErro('SANKHYA_ERRO_API', `Entidade ${input.entityName} não encontrada.`);
    const results: unknown[][] = [];
    for (const r of input.records) {
      let alvo: Record<string, unknown> | undefined;
      if (r.pk) {
        alvo = t.registros.find((x) => Object.entries(r.pk!).every(([k, v]) => String(x[k]) === String(v)));
        if (!alvo) throw new ForjaErro('SANKHYA_ERRO_API', 'Registro não encontrado para atualizar.');
      } else {
        alvo = { [t.pk[0]!]: t.proximoId++ };
        t.registros.push(alvo);
      }
      Object.assign(alvo, r.values);
      results.push([...t.pk, ...input.fields].map((f) => alvo![f] ?? null));
    }
    return { results, transactionId: `falso-${this.chamadas.length}` };
  }

  /** Chamadas que alteram algo (save). Leituras de dicionário não contam. */
  get gravacoes(): ChamadaFalsa[] {
    return this.chamadas.filter((c) => c.servico === 'DatasetSP.save');
  }
}
