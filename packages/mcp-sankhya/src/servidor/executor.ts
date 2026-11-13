import type { Auditoria } from '../auditoria/registro.js';
import { ForjaErro } from '../comum/erros.js';
import { mascarar, mensagemSegura } from '../comum/mascara.js';
import type { ConfigArquivo } from '../config/esquema.js';
import { usuarioBancoConfere } from '../config/trava-producao.js';
import type { Confirmacoes } from '../ferramentas/confirmacoes.js';
import type { ContextoExecucao, Ferramenta } from '../ferramentas/tipos.js';
import type { Gateway } from '../gateway/tipos.js';
import type { Capturador, Construtor } from '../navegador/tipos.js';
import type { Plano } from '../porteiro/planos.js';
import { avaliar, NOMES_REGRAS, type DependenciasPorteiro } from '../porteiro/porteiro.js';
import { comoObjetos, SQL } from '../sankhya/dicionario.js';

export interface RespostaFerramenta {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

export interface DependenciasExecutor {
  ferramentas: Map<string, Ferramenta>;
  config: ConfigArquivo;
  ambiente: string;
  usuarioBancoEsperado: string;
  usuario: string | undefined;
  chaveAprovacao: string;
  diretorioPlanos: string;
  auditoria: Auditoria;
  gateway: Gateway;
  construtor: () => Construtor;
  novoCapturador: (ferramenta: string) => Capturador;
  confirmacoes: Confirmacoes;
  lerPlano: (id: string) => Plano | undefined;
  agora?: () => Date;
  /** Chamado quando a base não é a esperada. O servidor real encerra o processo. */
  encerrar: (motivo: string) => void;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

const texto = (t: string, erro = false): RespostaFerramenta => ({ ...(erro ? { isError: true } : {}), content: [{ type: 'text', text: t }] });

/** Mutex simples: uma ferramenta de navegador por vez. */
class Mutex {
  private fila: Promise<void> = Promise.resolve();
  async rodar<T>(fn: () => Promise<T>): Promise<T> {
    let liberar!: () => void;
    const vez = new Promise<void>((r) => (liberar = r));
    const anterior = this.fila;
    this.fila = anterior.then(() => vez);
    await anterior;
    try {
      return await fn();
    } finally {
      liberar();
    }
  }
}

/**
 * Pipeline de toda chamada: porteiro → (trava de ambiente) → execução → auditoria.
 * Toda chamada termina em exatamente um registro de auditoria (aceito, recusado ou erro).
 */
export class Executor {
  private ambienteConferido: Promise<void> | undefined;
  private travado: string | undefined;
  private readonly navegador = new Mutex();
  /** Passos de plano em execução agora: fecha a janela entre "não executado" (regra 2) e o registro na auditoria. */
  private readonly passosEmCurso = new Set<string>();
  private readonly agora: () => Date;

  constructor(private readonly d: DependenciasExecutor) {
    this.agora = d.agora ?? (() => new Date());
  }

  private depsPorteiro(): DependenciasPorteiro {
    return {
      config: this.d.config,
      ambiente: this.d.ambiente,
      usuario: this.d.usuario,
      chaveAprovacao: this.d.chaveAprovacao,
      agora: this.agora,
      lerPlano: this.d.lerPlano,
      passoJaExecutado: (id, n) => this.d.auditoria.passoExecutado(id, n),
    };
  }

  /** SELECT USER FROM DUAL tem de bater com usuario_banco_esperado. Uma vez por processo. */
  private garantirAmbiente(): Promise<void> {
    this.ambienteConferido ??= (async () => {
      const r = comoObjetos(await this.d.gateway.executeQuery(SQL.usuarioBanco()));
      const obtido = r[0]?.USUARIO;
      if (!usuarioBancoConfere(obtido, this.d.usuarioBancoEsperado)) {
        this.travado = `TRAVA DE AMBIENTE: o Gateway respondeu como usuário de banco "${String(obtido)}", esperado "${this.d.usuarioBancoEsperado}". O servidor foi travado e será encerrado.`;
        throw new ForjaErro('AMBIENTE_ERRADO', this.travado);
      }
    })().catch((e: unknown) => {
      if (!this.travado) this.ambienteConferido = undefined; // falha de rede: tenta de novo na próxima
      throw e;
    });
    return this.ambienteConferido;
  }

  async chamar(nome: string, bruto: unknown): Promise<RespostaFerramenta> {
    const usuario = this.d.usuario;
    const perfil = usuario ? this.d.config.usuarios[usuario] : undefined;
    const base = { usuario, perfil, ambiente: this.d.ambiente, ferramenta: nome, parametros: bruto ?? {} };

    if (this.travado) {
      this.d.auditoria.registrar({ ...base, resultado: 'recusado', motivo: this.travado });
      return texto(`RECUSADO: ${this.travado}`, true);
    }

    const def = this.d.ferramentas.get(nome);
    if (!def) {
      const motivo = `[regra 7 – ${NOMES_REGRAS[7]}] Ferramenta desconhecida: "${nome}".`;
      this.d.auditoria.registrar({ ...base, resultado: 'recusado', motivo });
      return texto(`RECUSADO ${motivo} Nada foi enviado ao Sankhya.`, true);
    }

    const dec = avaliar(def, bruto, this.depsPorteiro());
    const ids = { planoId: dec.planoId, passoId: dec.passoId };
    if (!dec.aceito) {
      const motivo = `[regra ${dec.regra} – ${NOMES_REGRAS[dec.regra]}] ${dec.motivo}`;
      this.d.auditoria.registrar({ ...base, ...ids, resultado: 'recusado', motivo });
      this.d.log?.warn({ ferramenta: nome, regra: dec.regra }, 'chamada recusada pelo porteiro');
      return texto(`RECUSADO pelo porteiro ${motivo}\nNada foi enviado ao Sankhya.`, true);
    }

    // Reserva síncrona (sem await entre a regra 2 e aqui): duas chamadas simultâneas do mesmo passo
    // não podem ambas passar pelo "passo já executado".
    const chavePasso = dec.planoId !== undefined && dec.passoId !== undefined ? `${dec.planoId}#${dec.passoId}` : undefined;
    if (chavePasso) {
      if (this.passosEmCurso.has(chavePasso)) {
        const motivo = `[regra 2 – ${NOMES_REGRAS[2]}] O passo ${dec.passoId} do plano "${dec.planoId}" já está em execução.`;
        this.d.auditoria.registrar({ ...base, ...ids, perfil: dec.perfil, resultado: 'recusado', motivo });
        return texto(`RECUSADO pelo porteiro ${motivo}\nNada foi enviado ao Sankhya.`, true);
      }
      this.passosEmCurso.add(chavePasso);
    }

    const ctx: ContextoExecucao = {
      gateway: this.d.gateway,
      construtor: this.d.construtor,
      config: this.d.config,
      ambiente: dec.ambiente,
      usuario: dec.usuario,
      planoId: dec.planoId,
      passoId: dec.passoId,
      diretorioPlanos: this.d.diretorioPlanos,
      novoCapturador: this.d.novoCapturador,
      confirmacoes: this.d.confirmacoes,
      agora: this.agora,
    };
    const aud = { ...base, perfil: dec.perfil, ...ids };
    try {
      if (def.usaSankhya) {
        try {
          await this.garantirAmbiente();
        } catch (e) {
          const motivo = mensagemSegura(e);
          this.d.auditoria.registrar({ ...aud, resultado: 'erro', motivo });
          if (this.travado) this.d.encerrar(this.travado);
          return texto(`ERRO: ${motivo}`, true);
        }
      }
      const rodar = () => def.executar(dec.params as never, ctx);
      const r = def.usaNavegador ? await this.navegador.rodar(rodar) : await rodar();
      this.d.auditoria.registrar({
        ...aud,
        resultado: 'aceito',
        motivo: r.motivo ?? 'executado',
        antes: r.antes,
        depois: r.depois,
        capturaPath: r.capturaPath,
      });
      return texto(JSON.stringify(mascarar(r.dados), null, 2));
    } catch (e) {
      const motivo = mensagemSegura(e);
      const det = e instanceof ForjaErro ? e.detalhes : undefined;
      const recusa = e instanceof ForjaErro && e.codigo === 'RECUSADO_EXECUCAO';
      this.d.auditoria.registrar({
        ...aud,
        resultado: recusa ? 'recusado' : 'erro',
        motivo: recusa ? `[execução] ${motivo}` : motivo,
        antes: det?.antes,
        depois: det?.depois,
        capturaPath: typeof det?.capturaPath === 'string' ? det.capturaPath : undefined,
      });
      this.d.log?.error({ ferramenta: nome, erro: motivo }, 'falha na execução');
      return texto(recusa ? `RECUSADO na execução: ${motivo}` : `ERRO: ${motivo}`, true);
    } finally {
      if (chavePasso) this.passosEmCurso.delete(chavePasso);
    }
  }
}
