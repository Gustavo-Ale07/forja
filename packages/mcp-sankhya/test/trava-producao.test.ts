import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lerConfigParaImportar as carregarConfig } from '../src/config/importar.js';
import { usuarioBancoConfere } from '../src/config/trava-producao.js';
import { SessaoNavegador } from '../src/navegador/sessao.js';
import { pastaTemporaria } from './ajuda.js';

const PRODUCAO = 'https://minha-base.sankhyacloud.com.br';
const TESTE = 'https://minha-base-teste.sankhyacloud.com.br';

const CONFIG = `
fuso: America/Sao_Paulo
ambientes:
  teste:
    host_permitido: minha-base-teste.sankhyacloud.com.br
    usuario_banco_esperado: USUARIO_TESTE
perfis:
  dev: { ambientes: [teste], acoes: { teste: { ler_dicionario: livre } } }
usuarios: { fulano: dev }
`;

const ENV = {
  FORJA_USUARIO: 'fulano',
  FORJA_TESTE_URL: TESTE,
  FORJA_TESTE_USUARIO: 'usuario.teste',
  FORJA_TESTE_SENHA: 'senha-falsa-123',
  FORJA_TESTE_GATEWAY_CLIENT_ID: 'id-falso',
  FORJA_TESTE_GATEWAY_CLIENT_SECRET: 'segredo-falso-456',
  FORJA_TESTE_GATEWAY_TOKEN: 'xtoken-falso-789',
  FORJA_CHAVE_APROVACAO: 'k'.repeat(40),
};

function raiz(config = CONFIG, env: Record<string, string> = ENV): string {
  const r = pastaTemporaria();
  fs.writeFileSync(path.join(r, 'forja.config.yaml'), config);
  fs.writeFileSync(path.join(r, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
  return r;
}

describe('forja.config.local.yaml por cima do genérico', () => {
  const GENERICO = CONFIG.replace('minha-base-teste.sankhyacloud.com.br', 'SUA-BASE-TESTE.sankhyacloud.com.br')
    .replace('USUARIO_TESTE', 'SEU_USUARIO_BANCO_TESTE')
    .replace('usuarios: { fulano: dev }', 'usuarios: { seu_usuario: dev }');
  const comLocal = (local: string) => {
    const r = raiz(GENERICO);
    fs.writeFileSync(path.join(r, 'forja.config.local.yaml'), local);
    return r;
  };

  it('sem o local, o genérico não casa com a URL real: recusa iniciar', () => {
    expect(() => carregarConfig(raiz(GENERICO))).toThrow(/recusada/);
  });

  it('o local troca host, usuário de banco e usuários; o resto vem do genérico', () => {
    const c = carregarConfig(
      comLocal(
        'ambientes:\n  teste:\n    host_permitido: minha-base-teste.sankhyacloud.com.br\n    usuario_banco_esperado: USUARIO_TESTE\nusuarios:\n  fulano: dev\n',
      ),
    );
    expect(c.ambiente.hostPermitido).toBe('minha-base-teste.sankhyacloud.com.br');
    expect(c.ambiente.usuarioBancoEsperado).toBe('USUARIO_TESTE');
    expect(c.usuarios.fulano).toBe('dev');
    expect(c.fuso).toBe('America/Sao_Paulo');
    expect(c.perfis.map((p) => p.nome)).toEqual(['dev']);
  });

  it('a trava de produção vale para o resultado mesclado', () => {
    expect(() =>
      carregarConfig(comLocal('ambientes:\n  teste:\n    host_permitido: minha-base.sankhyacloud.com.br\n')),
    ).toThrow(/parece produção/);
    expect(() =>
      carregarConfig(comLocal('ambientes:\n  producao:\n    host_permitido: minha-base.sankhyacloud.com.br\n    usuario_banco_esperado: X\n')),
    ).toThrow(/além de "teste"/);
  });
});

describe('trava de produção ao importar (YAML + .env)', () => {
  it('configuração de teste correta inicia', () => {
    const c = carregarConfig(raiz());

    expect(c.ambiente.hostPermitido).toBe('minha-base-teste.sankhyacloud.com.br');
  });

  it('FORJA_TESTE_URL apontando para produção: recusa iniciar', () => {
    expect(() => carregarConfig(raiz(CONFIG, { ...ENV, FORJA_TESTE_URL: PRODUCAO }))).toThrow(/recusada[\s\S]*minha-base.sankhyacloud\.com\.br/);
  });

  it('host_permitido de produção no config: recusa iniciar', () => {
    const cfg = CONFIG.replace('minha-base-teste.sankhyacloud.com.br', 'minha-base.sankhyacloud.com.br');
    expect(() => carregarConfig(raiz(cfg, { ...ENV, FORJA_TESTE_URL: PRODUCAO }))).toThrow(/parece produção/);
  });

  it('ambiente extra (producao) no config: recusa iniciar', () => {
    const cfg = `${CONFIG.replace('perfis:', `  producao:\n    host_permitido: minha-base.sankhyacloud.com.br\n    usuario_banco_esperado: SANKHYA\nperfis:`)}`;
    expect(() => carregarConfig(raiz(cfg))).toThrow(/além de "teste"/);
  });

  it('variável FORJA_PROD* no .env: recusa iniciar', () => {
    expect(() => carregarConfig(raiz(CONFIG, { ...ENV, FORJA_PROD_URL: PRODUCAO }))).toThrow(/FORJA_PROD_URL/);
  });

  it('http sem TLS e URL com credencial: recusa', () => {
    expect(() => carregarConfig(raiz(CONFIG, { ...ENV, FORJA_TESTE_URL: 'http://minha-base-teste.sankhyacloud.com.br' }))).toThrow(/https/);
    expect(() => carregarConfig(raiz(CONFIG, { ...ENV, FORJA_TESTE_URL: 'https://u:s@minha-base-teste.sankhyacloud.com.br' }))).toThrow(/usuário\/senha/);
  });

  it('gateway fora da lista permitida: recusa', () => {
    const cfg = CONFIG.replace('usuario_banco_esperado: USUARIO_TESTE', 'usuario_banco_esperado: USUARIO_TESTE\n    gateway_url: https://gateway.malicioso.com');
    expect(() => carregarConfig(raiz(cfg))).toThrow(/Gateway/);
  });

  it('navegador recusa URL de produção mesmo se chamado direto', () => {
    expect(
      () => new SessaoNavegador({ url: PRODUCAO, hostPermitido: 'minha-base-teste.sankhyacloud.com.br', usuario: 'u', senha: 's', visivel: false }),
    ).toThrow(/fora do host permitido/);
  });
});

describe('trava de base (SELECT USER FROM DUAL)', () => {
  it('confere sem diferenciar maiúsculas/espaços', () => {
    expect(usuarioBancoConfere('USUARIO_TESTE', 'USUARIO_TESTE')).toBe(true);
    expect(usuarioBancoConfere(' usuario_teste ', 'USUARIO_TESTE')).toBe(true);
  });
  it('base de produção ou vazia não confere', () => {
    expect(usuarioBancoConfere('SANKHYA', 'USUARIO_TESTE')).toBe(false);
    expect(usuarioBancoConfere(undefined, 'USUARIO_TESTE')).toBe(false);
    expect(usuarioBancoConfere('', 'USUARIO_TESTE')).toBe(false);
  });
});
