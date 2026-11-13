import fs from 'node:fs';
import { MOTIVOS_EXECUTADO, type ResultadoReserva } from '@forja/banco';
import os from 'node:os';
import path from 'node:path';
import { linhaAuditoria, type Auditoria, type EventoNovo } from '../src/auditoria/registro.js';
import { esquemaConfig, type ConfigArquivo } from '../src/config/esquema.js';
import { Confirmacoes } from '../src/ferramentas/confirmacoes.js';
import { registroFerramentas } from '../src/ferramentas/index.js';
import { GatewayFalso } from '../src/gateway/falso.js';
import { criarCapturador } from '../src/navegador/capturas.js';
import { ConstrutorFalso } from '../src/navegador/falso.js';
import { aprovarPasso, assinarPlano, gravarPlano, lerPlano, type Plano } from '../src/porteiro/planos.js';
import type { DependenciasPorteiro } from '../src/porteiro/porteiro.js';
import { Executor, type Identidade } from '../src/servidor/executor.js';

export const CHAVE = 'chave-de-teste-com-mais-de-32-caracteres-0123456789';
/** Quarta-feira, 11/11/2026, 10:00 em São Paulo. */
export const QUARTA_10H = new Date('2026-11-11T13:00:00Z');

export function configBase(ajuste: (c: Record<string, any>) => void = () => {}): ConfigArquivo {
  const bruto: Record<string, any> = {
    fuso: 'America/Sao_Paulo',
    gateway_hosts_permitidos: ['api.sankhya.com.br'],
    ambientes: {
      teste: {
        host_permitido: 'minha-base-teste.sankhyacloud.com.br',
        usuario_banco_esperado: 'USUARIO_TESTE',
        gateway_url: 'https://api.sankhya.com.br',
      },
    },
    perfis: {
      desenvolvedor: {
        ambientes: ['teste'],
        acoes: {
          teste: {
            ler_dicionario: 'livre',
            consultar_sql: 'livre',
            carregar_registros: 'livre',
            propor_plano: 'livre',
            criar_tabela_ad: 'livre',
            criar_campo_ad: 'livre',
            definir_opcoes_lista: 'livre',
            marcar_obrigatorio: 'livre',
            gravar_registros: 'com_aprovacao',
          },
        },
      },
      leitor: { ambientes: ['teste'], acoes: { teste: { ler_dicionario: 'livre', consultar_sql: 'livre' } } },
      sem_ambiente: { ambientes: ['outro'], acoes: { teste: { ler_dicionario: 'livre' } } },
    },
    usuarios: { fulano: 'desenvolvedor', ana: 'leitor', bia: 'sem_ambiente', fantasma: 'perfil_que_nao_existe' },
    regras: {
      horario: { inicio: '07:00', fim: '20:00', dias: [1, 2, 3, 4, 5] },
      limite_registros_por_execucao: 50,
      leitura_bloqueada: ['TSI*'],
      gravacao_nativa_liberada: [],
    },
  };
  ajuste(bruto);
  return esquemaConfig.parse(bruto);
}

export function pastaTemporaria(prefixo = 'forja-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
}

/** Grava e assina um plano (como o forja-aprovar faria). */
export function planoAssinado(
  dir: string,
  id: string,
  passos: Array<{ ferramenta: string; parametros: Record<string, unknown> }>,
  aprovarPassos: number[] = [],
): Plano {
  let p: Plano = assinarPlano(
    { id, descricao: `plano ${id}`, passos: passos.map((s, i) => ({ n: i + 1, ...s })) },
    CHAVE,
    'fulano',
    QUARTA_10H,
  );
  for (const n of aprovarPassos) p = aprovarPasso(p, n, CHAVE, 'fulano', QUARTA_10H);
  gravarPlano(dir, p);
  return p;
}

export function depsPorteiro(o: Partial<DependenciasPorteiro> & { dir?: string; executados?: Set<string> } = {}): DependenciasPorteiro {
  const dir = o.dir ?? pastaTemporaria();
  const exec = o.executados ?? new Set<string>();
  return {
    config: o.config ?? configBase(),
    ambiente: o.ambiente ?? 'teste',
    usuario: 'usuario' in o ? o.usuario : 'fulano',
    chaveAprovacao: o.chaveAprovacao ?? CHAVE,
    agora: o.agora ?? (() => QUARTA_10H),
    lerPlano: o.lerPlano ?? ((id) => lerPlano(dir, id)),
    passoJaExecutado: o.passoJaExecutado ?? ((id, n) => exec.has(`${id}#${n}`)),
  };
}

export function montarExecutor(o: { config?: ConfigArquivo; usuario?: string; agora?: Date; identidade?: () => Promise<Identidade> } = {}) {
  const raiz = pastaTemporaria();
  const planos = path.join(raiz, 'planos');
  fs.mkdirSync(planos);
  const gw = new GatewayFalso();
  const construtor = new ConstrutorFalso(gw.base);
  const auditoria = new AuditoriaMemoria();
  const encerrados: string[] = [];
  const ferramentas = registroFerramentas();
  const config = o.config ?? configBase();
  const deps: ConstructorParameters<typeof Executor>[0] = {
    ferramentas,
    config,
    ambiente: 'teste',
    usuarioBancoEsperado: 'USUARIO_TESTE',
    usuario: o.usuario ?? 'fulano',
    chaveAprovacao: CHAVE,
    diretorioPlanos: planos,
    auditoria,
    gateway: gw,
    construtor: () => construtor,
    novoCapturador: (f) => criarCapturador(path.join(raiz, 'capturas'), f, config.fuso),
    confirmacoes: new Confirmacoes(),
    lerPlano: (id) => lerPlano(planos, id),
    agora: () => o.agora ?? QUARTA_10H,
    encerrar: (m) => encerrados.push(m),
    ...(o.identidade ? { identidade: o.identidade } : {}),
  };
  const executor = new Executor(deps);
  /** Outro processo do servidor com o mesmo banco (estado em memória zerado). */
  const reiniciar = () => new Executor(deps);
  const eventos = () => auditoria.linhas;
  return { raiz, planos, gw, construtor, auditoria, executor, reiniciar, encerrados, eventos, ferramentas };
}

export const textoDe = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

/** Linha como fica na tabela (JSONs em texto, já mascarados). */
export interface LinhaMemoria {
  id: string;
  reserva_id: string | null;
  usuario_id: string | null;
  usuario: string | null;
  perfil: string | null;
  ambiente: string;
  ferramenta: string;
  parametros: string;
  plano_id: string | null;
  passo_id: number | null;
  resultado: EventoNovo['resultado'] | 'em_execucao';
  motivo: string;
  antes_json: string | null;
  depois_json: string | null;
  captura_path: string | null;
}

/** Auditoria dos testes: mesma máscara e mesma regra de "passo executado" da do Postgres. */
export class AuditoriaMemoria implements Auditoria {
  readonly linhas: LinhaMemoria[] = [];
  async registrar(ev: EventoNovo): Promise<void> {
    const l = linhaAuditoria(ev);
    this.linhas.push({
      id: String(this.linhas.length + 1),
      reserva_id: l.reservaId ?? null,
      usuario_id: l.usuarioId ?? null,
      usuario: l.usuario ?? null,
      perfil: l.perfil ?? null,
      ambiente: l.ambiente,
      ferramenta: l.ferramenta,
      parametros: l.parametrosJson,
      plano_id: l.planoId ?? null,
      passo_id: l.passoId ?? null,
      resultado: l.resultado,
      motivo: l.motivo,
      antes_json: l.antesJson ?? null,
      depois_json: l.depoisJson ?? null,
      captura_path: l.capturaPath ?? null,
    });
  }
  async passoExecutado(planoId: string, passoId: number): Promise<boolean> {
    return this.linhas.some((l) => l.plano_id === planoId && l.passo_id === passoId && l.resultado === 'aceito' && MOTIVOS_EXECUTADO.includes(l.motivo));
  }
  async reservar(ev: Omit<EventoNovo, 'resultado' | 'motivo'>): Promise<ResultadoReserva> {
    const { planoId, passoId } = ev;
    if (!planoId || passoId === undefined) throw new Error('reservar exige plano e passo.');
    const aberta = this.linhas.find(
      (r) => r.resultado === 'em_execucao' && r.plano_id === planoId && r.passo_id === passoId && !this.linhas.some((d) => d.reserva_id === r.id),
    );
    if (aberta) return { reservado: false, situacao: 'em_execucao', reserva: { ...aberta, data_hora: new Date(), parametros: JSON.parse(aberta.parametros), antes: null, depois: null, resultado: 'em_execucao' } };
    if (await this.passoExecutado(planoId, passoId)) return { reservado: false, situacao: 'executado' };
    await this.registrar({ ...ev, resultado: 'em_execucao' as never, motivo: 'reserva: em execução' });
    return { reservado: true, reservaId: this.linhas.at(-1)!.id };
  }
}
