import { describe, expect, it } from 'vitest';
import { esquemaConfig } from '../src/config/esquema.js';
import { paraConfigImportada, VARIAVEIS_CREDENCIAL } from '../src/config/importar.js';
import { verificarAmbiente } from '../src/config/trava-producao.js';

const TESTE = 'https://minha-base-teste.sankhyacloud.com.br';

const arquivo = (host = 'minha-base-teste.sankhyacloud.com.br', extra: Record<string, unknown> = {}) =>
  esquemaConfig.parse({
    fuso: 'America/Sao_Paulo',
    ambientes: { teste: { host_permitido: host, usuario_banco_esperado: 'USUARIO_TESTE', ...extra } },
    perfis: {
      dev: { descricao: 'Desenvolvedor', ambientes: ['teste'], acoes: { teste: { ler_dicionario: 'livre', criar_campo_ad: 'com_aprovacao' } } },
    },
    usuarios: { fulano: 'dev' },
  });

const ENV: Record<string, string> = {
  FORJA_USUARIO: 'fulano',
  FORJA_TESTE_URL: TESTE,
  FORJA_TESTE_USUARIO: 'usuario.teste',
  FORJA_TESTE_SENHA: 'senha-falsa-123',
  FORJA_TESTE_GATEWAY_CLIENT_ID: 'id-falso',
  FORJA_TESTE_GATEWAY_CLIENT_SECRET: 'segredo-falso-456',
  FORJA_TESTE_GATEWAY_TOKEN: 'xtoken-falso-789',
};

describe('verificarAmbiente (trava sobre dados do banco)', () => {
  const ok = { url: TESTE, hostPermitido: 'minha-base-teste.sankhyacloud.com.br', gatewayUrl: 'https://api.sandbox.sankhya.com.br' };

  it('aceita host de teste, https e Gateway conhecido', () => {
    expect(verificarAmbiente(ok)).toEqual([]);
    expect(verificarAmbiente({ ...ok, gatewayUrl: 'https://api.sankhya.com.br' })).toEqual([]);
  });

  it('recusa host sem marca de teste', () => {
    const p = verificarAmbiente({ ...ok, url: 'https://minha-base.sankhyacloud.com.br', hostPermitido: 'minha-base.sankhyacloud.com.br' });
    expect(p.join('\n')).toMatch(/parece produção/);
  });

  it('recusa http, host divergente e credencial embutida na URL', () => {
    expect(verificarAmbiente({ ...ok, url: TESTE.replace('https', 'http') }).join('\n')).toMatch(/https/);
    expect(verificarAmbiente({ ...ok, url: 'https://outra-teste.sankhyacloud.com.br' }).join('\n')).toMatch(/host permitido/);
    expect(verificarAmbiente({ ...ok, url: 'https://u:s@minha-base-teste.sankhyacloud.com.br' }).join('\n')).toMatch(/usuário\/senha/);
    expect(verificarAmbiente({ ...ok, url: 'não é url' }).join('\n')).toMatch(/inválida/);
  });

  it('recusa Gateway fora da lista fixa ou sem https', () => {
    expect(verificarAmbiente({ ...ok, gatewayUrl: 'https://gateway-teste.exemplo.com' }).join('\n')).toMatch(/não é um host do Gateway/);
    expect(verificarAmbiente({ ...ok, gatewayUrl: 'http://api.sandbox.sankhya.com.br' }).join('\n')).toMatch(/https/);
  });
});

describe('paraConfigImportada (YAML + .env → banco)', () => {
  it('converte perfis, usuários, regras, ambiente e as 5 credenciais', () => {
    const { config, problemas } = paraConfigImportada(arquivo(), ENV);
    expect(problemas).toEqual([]);
    expect(config!.ambiente).toMatchObject({ url: TESTE, hostPermitido: 'minha-base-teste.sankhyacloud.com.br', usuarioBancoEsperado: 'USUARIO_TESTE' });
    expect(config!.perfis).toEqual([
      expect.objectContaining({ nome: 'dev', descricao: 'Desenvolvedor', ambientes: ['teste'], acoes: { teste: { ler_dicionario: 'livre', criar_campo_ad: 'com_aprovacao' } } }),
    ]);
    expect(config!.usuarios).toEqual({ fulano: 'dev' });
    expect(config!.fuso).toBe('America/Sao_Paulo');
    expect(Object.keys(config!.credenciais).sort()).toEqual(Object.keys(VARIAVEIS_CREDENCIAL).sort());
    expect(config!.credenciais.gateway_token).toBe('xtoken-falso-789');
  });

  it('sem as FORJA_TESTE_* de credencial, importa o resto e não inventa credencial', () => {
    const env = { FORJA_USUARIO: 'fulano', FORJA_TESTE_URL: TESTE };
    const r = paraConfigImportada(arquivo(), env);
    expect(r.problemas).toEqual([]);
    expect(r.config!.credenciais).toEqual({});
  });

  it('recusa base de produção e não devolve config', () => {
    const r = paraConfigImportada(arquivo('minha-base.sankhyacloud.com.br'), { ...ENV, FORJA_TESTE_URL: 'https://minha-base.sankhyacloud.com.br' });
    expect(r.config).toBeUndefined();
    expect(r.problemas.join('\n')).toMatch(/produção/);
  });

  it('recusa URL do .env que não bate com o host permitido', () => {
    const r = paraConfigImportada(arquivo(), { ...ENV, FORJA_TESTE_URL: 'https://outra-teste.sankhyacloud.com.br' });
    expect(r.config).toBeUndefined();
    expect(r.problemas.length).toBeGreaterThan(0);
  });

  it('recusa Gateway fora da lista fixa', () => {
    const r = paraConfigImportada(arquivo(undefined, { gateway_url: 'https://gateway-teste.exemplo.com' }), ENV);
    expect(r.config).toBeUndefined();
    expect(r.problemas.join('\n')).toMatch(/Gateway/);
  });

  it('sem FORJA_TESTE_URL não há o que importar', () => {
    const { FORJA_TESTE_URL: _, ...semUrl } = ENV;
    expect(paraConfigImportada(arquivo(), semUrl).config).toBeUndefined();
  });
});
