import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registroFerramentas } from '../src/ferramentas/index.js';
import { avaliar, type Decisao } from '../src/porteiro/porteiro.js';
import { CHAVE, configBase, depsPorteiro, pastaTemporaria, planoAssinado } from './ajuda.js';

const F = registroFerramentas();
const def = (n: string) => F.get(n)!;

function recusa(d: Decisao, regra: number, trecho?: RegExp) {
  expect(d.aceito, JSON.stringify(d)).toBe(false);
  if (d.aceito) return;
  expect(d.regra, d.motivo).toBe(regra);
  if (trecho) expect(d.motivo).toMatch(trecho);
}

const tabelaOk = {
  nome: 'AD_FORJATESTE',
  descricao: 'Teste Forja',
};

/** Plano assinado com um passo e chamada correspondente. */
function comPlano(ferramenta: string, parametros: Record<string, unknown>, aprovar: number[] = []) {
  const dir = pastaTemporaria();
  planoAssinado(dir, 'p1', [{ ferramenta, parametros }], aprovar);
  return { dir, params: { ...parametros, plano_id: 'p1', passo_id: 1 } };
}

describe('regra 1 – usuário e perfil', () => {
  it('recusa sem FORJA_USUARIO', () => {
    recusa(avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro({ usuario: undefined })), 1, /não identificado/);
  });
  it('recusa usuário não cadastrado', () => {
    recusa(avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro({ usuario: 'intruso' })), 1, /não está cadastrado/);
  });
  it('recusa perfil inexistente', () => {
    recusa(avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro({ usuario: 'fantasma' })), 1, /não existe/);
  });
  it('aceita leitura livre sem plano', () => {
    const d = avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro());
    expect(d.aceito).toBe(true);
  });
});

describe('regra 2 – plano aprovado', () => {
  it('alteração sem plano é recusada', () => {
    recusa(avaliar(def('criar_tabela_ad'), tabelaOk, depsPorteiro()), 2, /exige plano_id/);
  });
  it('plano inexistente', () => {
    recusa(avaliar(def('criar_tabela_ad'), { ...tabelaOk, plano_id: 'nao-existe', passo_id: 1 }, depsPorteiro()), 2, /não encontrado/);
  });
  it('plano sem assinatura (rascunho) é recusado', () => {
    const dir = pastaTemporaria();
    fs.writeFileSync(
      path.join(dir, 'r.json'),
      JSON.stringify({ id: 'r', descricao: '', passos: [{ n: 1, ferramenta: 'criar_tabela_ad', parametros: tabelaOk }] }),
    );
    recusa(avaliar(def('criar_tabela_ad'), { ...tabelaOk, plano_id: 'r', passo_id: 1 }, depsPorteiro({ dir })), 2, /sem assinatura/);
  });
  it('plano alterado depois de assinado é recusado', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    const arq = path.join(dir, 'p1.json');
    const p = JSON.parse(fs.readFileSync(arq, 'utf8'));
    p.passos[0].parametros.nome = 'AD_OUTRA';
    fs.writeFileSync(arq, JSON.stringify(p));
    recusa(avaliar(def('criar_tabela_ad'), { ...params, nome: 'AD_OUTRA' }, depsPorteiro({ dir })), 2);
  });
  it('assinatura com outra chave é recusada', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    recusa(avaliar(def('criar_tabela_ad'), params, depsPorteiro({ dir, chaveAprovacao: `${CHAVE}-outra` })), 2);
  });
  it('parâmetros diferentes do passo aprovado são recusados', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    recusa(avaliar(def('criar_tabela_ad'), { ...params, nome: 'AD_OUTRA' }, depsPorteiro({ dir })), 2, /hash diferente/);
  });
  it('passo de outra ferramenta é recusado', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    recusa(avaliar(def('criar_campo_ad'), params, depsPorteiro({ dir })), 2, /é de "criar_tabela_ad"/);
  });
  it('passo já executado é recusado', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    recusa(avaliar(def('criar_tabela_ad'), params, depsPorteiro({ dir, executados: new Set(['p1#1']) })), 2, /já foi executado/);
  });
  it('plano assinado e parâmetros exatos: aceito', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    const d = avaliar(def('criar_tabela_ad'), params, depsPorteiro({ dir }));
    expect(d.aceito, JSON.stringify(d)).toBe(true);
  });
});

describe('regra 3 – ambiente', () => {
  it('perfil sem acesso ao ambiente', () => {
    recusa(avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro({ usuario: 'bia' })), 3);
  });
  it('ambiente somente leitura recusa alteração', () => {
    const { dir, params } = comPlano('criar_tabela_ad', tabelaOk);
    const config = configBase((c) => (c.ambientes.teste.somente_leitura = true));
    recusa(avaliar(def('criar_tabela_ad'), params, depsPorteiro({ dir, config })), 3, /somente leitura/);
  });
});

describe('regra 4 – nível da ação', () => {
  it('ação não listada no perfil = bloqueada', () => {
    recusa(avaliar(def('carregar_registros'), { entidade: 'AD_X', campos: ['ID'] }, depsPorteiro({ usuario: 'ana' })), 4, /bloqueada/);
  });
  it('com_aprovacao sem aprovação do passo é recusada', () => {
    const p = { entidade: 'AD_FORJATESTE', registros: [{ valores: { DESCRICAO: 'x' } }] };
    const { dir, params } = comPlano('gravar_registros', p);
    recusa(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })), 4, /aprova/i);
  });
  it('com_aprovacao com passo aprovado: aceito', () => {
    const p = { entidade: 'AD_FORJATESTE', registros: [{ valores: { DESCRICAO: 'x' } }] };
    const { dir, params } = comPlano('gravar_registros', p, [1]);
    expect(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })).aceito).toBe(true);
  });
});

describe('regra 5 – travas fixas (e tentativas de burla)', () => {
  const campoEm = (tabela: string) => ({ tabela, campo: 'TESTE', tipo: 'texto' });

  for (const tabela of ['TGFCAB', 'tgfcab', ' TgfCab ', 'TSIUSU', 'TGFPAR']) {
    it(`estrutura em "${tabela}" é recusada mesmo com plano assinado`, () => {
      const { dir, params } = comPlano('criar_campo_ad', campoEm(tabela));
      recusa(avaliar(def('criar_campo_ad'), params, depsPorteiro({ dir })), 5);
    });
  }
  for (const [rotulo, tabela] of [
    ['A cirílico', 'АD_FORJA'],
    ['largura zero', 'AD_​FORJA'],
    ['AD no meio', 'TGFCAB_AD_X'],
    ['só AD_', 'AD_'],
    ['espaço interno', 'AD_ FORJA'],
  ] as const) {
    it(`prefixo AD_ falso (${rotulo}) é recusado`, () => {
      const { dir, params } = comPlano('criar_campo_ad', campoEm(tabela));
      recusa(avaliar(def('criar_campo_ad'), params, depsPorteiro({ dir })), 5);
    });
  }
  for (const tabela of ['TGFTOP', 'TGFFIN', 'TGFCAB', 'TSIUSU', 'TDDCAM', 'tcbint']) {
    it(`gravação em ${tabela} (fiscal/financeiro/usuários/dicionário) é recusada`, () => {
      const p = { entidade: tabela, registros: [{ chave: { ID: 1 }, valores: { X: 1 } }] };
      const { dir, params } = comPlano('gravar_registros', p, [1]);
      recusa(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })), 5);
    });
  }
  it('UPDATE sem filtro (chave vazia) é recusado', () => {
    const p = { entidade: 'AD_FORJATESTE', registros: [{ chave: {}, valores: { DESCRICAO: 'x' } }] };
    const { dir, params } = comPlano('gravar_registros', p, [1]);
    recusa(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })), 5, /UPDATE sem chave/);
  });
  it('UPDATE com chave nula é recusado', () => {
    const p = { entidade: 'AD_FORJATESTE', registros: [{ chave: { ID: null }, valores: { DESCRICAO: 'x' } }] };
    const { dir, params } = comPlano('gravar_registros', p, [1]);
    recusa(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })), 5, /UPDATE sem chave/);
  });

  for (const sql of [
    'DELETE FROM AD_FORJATESTE',
    'delete from ad_forjateste',
    'SELECT 1 FROM DUAL; DROP TABLE AD_FORJATESTE',
    'UPDATE TGFPAR SET NOMEPARC = 1',
    'SELECT * FROM TGFPAR -- comentário\n; DELETE FROM TGFPAR',
    'WITH x AS (DELETE FROM TGFPAR RETURNING *) SELECT * FROM x',
    'SELECT * FROM TGFPAR WHERE 1 = 1 UNION ALL SELECT * FROM TGFPAR FOR UPDATE',
    'TRUNCATE TABLE AD_X',
    'MERGE INTO AD_X USING DUAL ON (1=1) WHEN MATCHED THEN UPDATE SET A = 1',
  ]) {
    it(`SQL não-SELECT é recusado: ${JSON.stringify(sql)}`, () => {
      recusa(avaliar(def('consultar_sql'), { sql }, depsPorteiro()), 5, /DML e DDL/);
    });
  }
});

describe('regra 6 – regras da empresa', () => {
  it('fora do horário (sábado)', () => {
    recusa(
      avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro({ agora: () => new Date('2026-11-14T13:00:00Z') })),
      6,
      /Fora do horário/,
    );
  });
  it('fora do horário (22h em São Paulo)', () => {
    recusa(
      avaliar(def('ler_dicionario'), { tabela: 'TGFPAR' }, depsPorteiro({ agora: () => new Date('2026-11-12T01:00:00Z') })),
      6,
      /Fora do horário/,
    );
  });
  it('limite de registros por execução', () => {
    const p = { entidade: 'AD_FORJATESTE', registros: Array.from({ length: 51 }, (_, i) => ({ valores: { DESCRICAO: `r${i}` } })) };
    const { dir, params } = comPlano('gravar_registros', p, [1]);
    recusa(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })), 6, /excedem o limite/);
  });
  it('gravação em tabela nativa não liberada', () => {
    const p = { entidade: 'TGFPAR', registros: [{ chave: { CODPARC: 1 }, valores: { AD_X: 1 } }] };
    const { dir, params } = comPlano('gravar_registros', p, [1]);
    recusa(avaliar(def('gravar_registros'), params, depsPorteiro({ dir })), 6, /nativa/);
  });
  it('gravação nativa liberada no config passa da regra 6', () => {
    const p = { entidade: 'TGFPAR', registros: [{ chave: { CODPARC: 1 }, valores: { AD_X: 1 } }] };
    const { dir, params } = comPlano('gravar_registros', p, [1]);
    const config = configBase((c) => (c.regras.gravacao_nativa_liberada = ['TGFPAR']));
    expect(avaliar(def('gravar_registros'), params, depsPorteiro({ dir, config })).aceito).toBe(true);
  });
  it('leitura de TSI* bloqueada (minúsculas e em subconsulta)', () => {
    recusa(avaliar(def('consultar_sql'), { sql: 'select * from tsiusu' }, depsPorteiro()), 6, /TSIUSU/);
    recusa(
      avaliar(def('consultar_sql'), { sql: 'SELECT * FROM TGFPAR WHERE CODUSU IN (SELECT CODUSU FROM TSIUSU)' }, depsPorteiro()),
      6,
      /TSIUSU/,
    );
    recusa(avaliar(def('ler_dicionario'), { tabela: 'tsiusu' }, depsPorteiro()), 6);
  });
  it('tabela fora do alcance do perfil', () => {
    const config = configBase((c) => (c.perfis.desenvolvedor.tabelas_bloqueadas = ['TGFPAR']));
    recusa(avaliar(def('consultar_sql'), { sql: 'SELECT CODPARC FROM TGFPAR' }, depsPorteiro({ config })), 6, /fora do alcance/);
  });
});

describe('regra 7 – parâmetros', () => {
  it('comentário escondendo DELETE é recusado', () => {
    recusa(avaliar(def('consultar_sql'), { sql: 'SELECT * FROM TGFPAR /* DELETE FROM TGFPAR */' }, depsPorteiro()), 7, /Comentários/);
    recusa(avaliar(def('consultar_sql'), { sql: 'SELECT * FROM TGFPAR -- DELETE FROM TGFPAR' }, depsPorteiro()), 7, /Comentários/);
  });
  it('coluna sensível é recusada', () => {
    recusa(avaliar(def('consultar_sql'), { sql: 'SELECT SENHA FROM AD_X' }, depsPorteiro()), 7, /sensível/);
  });
  it('tamanho de campo fora das combinações lista as aceitas', () => {
    const p = { tabela: 'AD_FORJATESTE', campo: 'OBS', tipo: 'texto', tamanho: 4000 };
    const { dir, params } = comPlano('criar_campo_ad', p);
    recusa(avaliar(def('criar_campo_ad'), params, depsPorteiro({ dir })), 7, /texto\/100, lista\/10, inteiro\/10, decimal\/126, data_hora\/7/);
  });
  it('campo com prefixo AD_ ou "_" é recusado', () => {
    for (const campo of ['AD_OBS', 'OBS_X']) {
      const p = { tabela: 'AD_FORJATESTE', campo, tipo: 'texto' };
      const { dir, params } = comPlano('criar_campo_ad', p);
      recusa(avaliar(def('criar_campo_ad'), params, depsPorteiro({ dir })), 7);
    }
  });
  it('criar_campo_ad com opcoes ou obrigatorio é recusado (viraram ferramentas próprias)', () => {
    for (const extra of [{ opcoes: [{ valor: 'A', descricao: 'Ativo' }] }, { obrigatorio: true }]) {
      const p = { tabela: 'AD_FORJATESTE', campo: 'SIT', tipo: 'lista', ...extra };
      const { dir, params } = comPlano('criar_campo_ad', p);
      recusa(avaliar(def('criar_campo_ad'), params, depsPorteiro({ dir })), 7);
    }
  });
  it('definir_opcoes_lista e marcar_obrigatorio exigem plano e só valem em AD_', () => {
    const op = { tabela: 'AD_FORJATESTE', campo: 'SIT', opcoes: [{ valor: 'A', descricao: 'Ativo' }] };
    recusa(avaliar(def('definir_opcoes_lista'), op, depsPorteiro()), 2);
    recusa(avaliar(def('marcar_obrigatorio'), { tabela: 'AD_FORJATESTE', campo: 'OBS' }, depsPorteiro()), 2);
    const nat = comPlano('definir_opcoes_lista', { ...op, tabela: 'TGFCAB' });
    recusa(avaliar(def('definir_opcoes_lista'), nat.params, depsPorteiro({ dir: nat.dir })), 5);
    const nat2 = comPlano('marcar_obrigatorio', { tabela: 'TSIUSU', campo: 'OBS' });
    recusa(avaliar(def('marcar_obrigatorio'), nat2.params, depsPorteiro({ dir: nat2.dir })), 5);
  });
  it('parâmetro extra desconhecido é recusado', () => {
    recusa(avaliar(def('ler_dicionario'), { tabela: 'TGFPAR', sql: 'x' }, depsPorteiro()), 7);
  });
  it('filtro com subconsulta é recusado', () => {
    recusa(
      avaliar(
        def('carregar_registros'),
        { entidade: 'AD_X', campos: ['ID'], filtro: { expressao: 'this.ID IN (SELECT 1 FROM DUAL)', parametros: [] } },
        depsPorteiro(),
      ),
      7,
      /subconsulta/,
    );
  });
  it('filtro com número errado de parâmetros é recusado', () => {
    recusa(
      avaliar(def('carregar_registros'), { entidade: 'AD_X', campos: ['ID'], filtro: { expressao: 'this.ID = ? AND this.X = ?', parametros: [{ valor: 1, tipo: 'I' }] } }, depsPorteiro()),
      7,
      /2 marcador/,
    );
  });
  it('WITH ... SELECT válido é aceito', () => {
    expect(avaliar(def('consultar_sql'), { sql: 'WITH X AS (SELECT CODPARC FROM TGFPAR) SELECT * FROM X' }, depsPorteiro()).aceito).toBe(true);
  });
});

describe('ordem das regras', () => {
  it('para no primeiro "não": usuário inválido antes de SQL proibido', () => {
    recusa(avaliar(def('consultar_sql'), { sql: 'DELETE FROM X' }, depsPorteiro({ usuario: 'intruso' })), 1);
  });
});
