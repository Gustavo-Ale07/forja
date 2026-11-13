import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CofreAesGcm } from '../src/cofre.js';
import { comEmpresa, criarBanco, type Db } from '../src/conexao.js';
import { gravarCredencial, lerCredencial, tiposCadastrados } from '../src/credenciais.js';
import { criarEmpresaCompleta, type EmpresaDeTeste } from './ajuda.js';
import { URL_APP, URL_DONO } from './urls.js';

let dono: Db;
let app: Db;
let A: EmpresaDeTeste;
let B: EmpresaDeTeste;
const cofre = new CofreAesGcm(crypto.randomBytes(32));
const SENHA_A = 'senha-falsa-da-empresa-a';
const SEGREDO_B = 'segredo-falso-da-empresa-b';

beforeAll(async () => {
  dono = criarBanco(URL_DONO);
  app = criarBanco(URL_APP);
  A = await criarEmpresaCompleta(dono, 'cred-a');
  B = await criarEmpresaCompleta(dono, 'cred-b');
  await comEmpresa(dono, A.id, (trx) =>
    gravarCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'web_senha', valor: SENHA_A }),
  );
  await comEmpresa(dono, B.id, (trx) =>
    gravarCredencial(trx, cofre, { empresaId: B.id, ambienteId: B.ambienteId, tipo: 'gateway_client_secret', valor: SEGREDO_B }),
  );
});

afterAll(async () => {
  await dono.destroy();
  await app.destroy();
});

describe('credenciais no banco', () => {
  it('o banco guarda só o texto cifrado', async () => {
    const linhas = await comEmpresa(dono, A.id, (trx) => trx.selectFrom('credencial').select(['tipo', 'cifrado', 'versao_chave']).execute());
    const senha = linhas.find((l) => l.tipo === 'web_senha')!;
    expect(senha.cifrado).toMatch(/^aesgcm\./);
    expect(senha.cifrado).not.toContain(SENHA_A);
    expect(senha.versao_chave).toBe(1);
  });

  it('o app (MCP) lê e decifra na hora de usar', async () => {
    const v = await comEmpresa(app, A.id, (trx) => lerCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'web_senha' }));
    expect(v).toBe(SENHA_A);
  });

  it('gravar de novo troca o valor (upsert)', async () => {
    await comEmpresa(dono, A.id, (trx) =>
      gravarCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'gateway_token', valor: 'token-1' }),
    );
    await comEmpresa(dono, A.id, (trx) =>
      gravarCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'gateway_token', valor: 'token-2' }),
    );
    const v = await comEmpresa(app, A.id, (trx) => lerCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'gateway_token' }));
    expect(v).toBe('token-2');
  });

  it('no contexto de A, a credencial de B não aparece', async () => {
    const v = await comEmpresa(app, A.id, (trx) =>
      lerCredencial(trx, cofre, { empresaId: A.id, ambienteId: B.ambienteId, tipo: 'gateway_client_secret' }),
    );
    expect(v).toBeUndefined();
    expect(await comEmpresa(app, A.id, (trx) => tiposCadastrados(trx, B.ambienteId))).toEqual([]);
  });

  it('o texto cifrado de B copiado para uma linha de A não decifra', async () => {
    const deB = await comEmpresa(dono, B.id, (trx) =>
      trx.selectFrom('credencial').select(['cifrado', 'versao_chave']).where('tipo', '=', 'gateway_client_secret').executeTakeFirstOrThrow(),
    );
    await comEmpresa(dono, A.id, (trx) =>
      trx
        .insertInto('credencial')
        .values({ empresa_id: A.id, ambiente_id: A.ambienteId, tipo: 'gateway_client_secret', cifrado: deB.cifrado, versao_chave: deB.versao_chave })
        .execute(),
    );
    await expect(
      comEmpresa(app, A.id, (trx) => lerCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'gateway_client_secret' })),
    ).rejects.toThrow(/Não foi possível decifrar/);
  });

  it('o app não grava credencial', async () => {
    await expect(
      comEmpresa(app, A.id, (trx) =>
        gravarCredencial(trx, cofre, { empresaId: A.id, ambienteId: A.ambienteId, tipo: 'web_usuario', valor: 'x' }),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
