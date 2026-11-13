import crypto from 'node:crypto';
import { comEmpresa, type Db } from '../src/conexao.js';

export interface EmpresaDeTeste {
  id: string;
  slug: string;
  perfilId: string;
  ambienteId: string;
  usuarioId: string;
}

const sufixo = () => crypto.randomBytes(4).toString('hex');

/** Cria (como dono) uma empresa com uma linha em cada tabela. Valores genéricos. */
export async function criarEmpresaCompleta(dono: Db, rotulo: string): Promise<EmpresaDeTeste> {
  const id = crypto.randomUUID();
  const slug = `${rotulo}-${sufixo()}`;
  return comEmpresa(dono, id, async (trx) => {
    await trx.insertInto('empresa').values({ id, nome: `Empresa ${rotulo}`, slug }).execute();
    const perfil = await trx
      .insertInto('perfil')
      .values({ empresa_id: id, nome: 'desenvolvedor', descricao: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    const ambiente = await trx
      .insertInto('ambiente')
      .values({
        empresa_id: id,
        nome: 'teste',
        url: `https://${slug}-teste.sankhyacloud.com.br`,
        host_permitido: `${slug}-teste.sankhyacloud.com.br`,
        usuario_banco_esperado: 'USUARIO_TESTE',
        gateway_url: 'https://api.sandbox.sankhya.com.br',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const usuario = await trx
      .insertInto('usuario')
      .values({ empresa_id: id, login: `fulano-${slug}`, nome: 'Fulano', perfil_id: perfil.id, senha_hash: null, totp_cifrado: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('sessao')
      .values({ empresa_id: id, usuario_id: usuario.id, token_hash: crypto.randomBytes(32), expira_em: new Date(Date.now() + 3600_000) })
      .execute();
    await trx.insertInto('perfil_ambiente').values({ empresa_id: id, perfil_id: perfil.id, ambiente_id: ambiente.id }).execute();
    await trx
      .insertInto('perfil_permissao')
      .values({ empresa_id: id, perfil_id: perfil.id, ambiente_id: ambiente.id, acao: 'consultar_sql', nivel: 'livre' })
      .execute();
    await trx.insertInto('perfil_tabela_bloqueada').values({ empresa_id: id, perfil_id: perfil.id, padrao: 'TGFFIN' }).execute();
    await trx
      .insertInto('credencial')
      .values({ empresa_id: id, ambiente_id: ambiente.id, tipo: 'web_senha', cifrado: 'cifrado-falso', versao_chave: 1 })
      .execute();
    await trx.insertInto('regra').values({ empresa_id: id }).execute();
    await trx.insertInto('instancia_tabela').values({ empresa_id: id, tabela: 'AD_EXEMPLO', instancia: 'AD_EXEMPLO' }).execute();
    await trx
      .insertInto('chamada_ferramenta')
      .values({
        empresa_id: id,
        usuario_id: usuario.id,
        usuario: 'fulano',
        perfil: 'desenvolvedor',
        ambiente: 'teste',
        ferramenta: 'consultar_sql',
        parametros: JSON.stringify({ sql: 'SELECT 1 FROM DUAL' }),
        plano_id: null,
        passo_id: null,
        resultado: 'aceito',
        motivo: 'executado',
        antes: null,
        depois: null,
        captura_path: null,
      })
      .execute();
    return { id, slug, perfilId: perfil.id, ambienteId: ambiente.id, usuarioId: usuario.id };
  });
}

/** Tabela → coluna que identifica a empresa. */
export const TABELAS_COM_EMPRESA = {
  empresa: 'id',
  perfil: 'empresa_id',
  ambiente: 'empresa_id',
  usuario: 'empresa_id',
  sessao: 'empresa_id',
  perfil_ambiente: 'empresa_id',
  perfil_permissao: 'empresa_id',
  perfil_tabela_bloqueada: 'empresa_id',
  credencial: 'empresa_id',
  regra: 'empresa_id',
  instancia_tabela: 'empresa_id',
  chamada_ferramenta: 'empresa_id',
} as const;
