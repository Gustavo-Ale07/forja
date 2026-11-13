#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Auditoria } from './auditoria/registro.js';
import { log } from './comum/log.js';
import { mensagemSegura } from './comum/mascara.js';
import { carregarConfigBanco } from './config/banco.js';
import { Confirmacoes } from './ferramentas/confirmacoes.js';
import { registroFerramentas } from './ferramentas/index.js';
import { criarClienteReal } from './gateway/cliente.js';
import { criarCapturador } from './navegador/capturas.js';
import { ConstrutorTelas } from './navegador/construtor-telas.js';
import { SessaoNavegador } from './navegador/sessao.js';
import type { Construtor } from './navegador/tipos.js';
import { lerPlano } from './porteiro/planos.js';
import { Executor } from './servidor/executor.js';
import { criarServidor } from './servidor/servidor.js';

process.env.TZ ??= 'America/Sao_Paulo';

async function principal(): Promise<void> {
  // Trava de produção + sessão válida (pnpm forja-admin login): qualquer problema = o servidor não inicia.
  const cfg = await carregarConfigBanco();
  const auditoria = new Auditoria(cfg.caminhos.bancoAuditoria);
  const gateway = criarClienteReal({
    gatewayUrl: cfg.configAmbiente.gateway_url,
    clientId: cfg.credenciais.clientId,
    clientSecret: cfg.credenciais.clientSecret,
    xToken: cfg.credenciais.xToken,
  });

  // Navegador só sobe quando uma ferramenta de estrutura precisar.
  let construtor: Construtor | undefined;
  const obterConstrutor = (): Construtor => {
    construtor ??= new ConstrutorTelas(
      new SessaoNavegador({
        url: cfg.credenciais.url,
        hostPermitido: cfg.configAmbiente.host_permitido,
        usuario: cfg.credenciais.usuario,
        senha: cfg.credenciais.senha,
        visivel: cfg.navegadorVisivel,
      }),
    );
    return construtor;
  };

  let encerrando = false;
  const encerrar = async (codigo: number, motivo?: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    if (motivo) log.fatal({ motivo }, 'encerrando');
    try {
      await construtor?.fechar();
    } catch {
      /* ignora */
    }
    auditoria.fechar();
    await cfg.app.destroy().catch(() => undefined);
    process.exit(codigo);
  };

  const ferramentas = registroFerramentas();
  const executor = new Executor({
    ferramentas,
    config: cfg.arquivo,
    ambiente: cfg.ambiente,
    usuarioBancoEsperado: cfg.configAmbiente.usuario_banco_esperado,
    usuario: cfg.login,
    identidade: cfg.identidade,
    chaveAprovacao: cfg.chaveAprovacao,
    diretorioPlanos: cfg.caminhos.planos,
    auditoria,
    gateway,
    construtor: obterConstrutor,
    novoCapturador: (f) => criarCapturador(cfg.caminhos.capturas, f, cfg.arquivo.fuso),
    confirmacoes: new Confirmacoes(),
    lerPlano: (id) => lerPlano(cfg.caminhos.planos, id),
    encerrar: (m) => void encerrar(2, m),
    log,
  });

  const server = criarServidor(ferramentas, executor);
  process.on('SIGINT', () => void encerrar(0));
  process.on('SIGTERM', () => void encerrar(0));
  await server.connect(new StdioServerTransport());
  log.info({ ambiente: cfg.ambiente, host: cfg.configAmbiente.host_permitido, usuario: cfg.login }, 'forja-sankhya pronto');
}

principal().catch((e: unknown) => {
  process.stderr.write(`${mensagemSegura(e)}\n`);
  process.exit(1);
});
