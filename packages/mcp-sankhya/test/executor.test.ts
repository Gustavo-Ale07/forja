import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lerPlano } from '../src/porteiro/planos.js';
import { CHAVE, montarExecutor, planoAssinado, textoDe } from './ajuda.js';
import { assinarPlano, gravarPlano } from '../src/porteiro/planos.js';

const FORJATESTE = { nome: 'AD_FORJATESTE', descricao: 'Teste Forja' };
const CAMPOS = [
  { tabela: 'AD_FORJATESTE', campo: 'DESCRICAO', descricao: 'Descrição', tipo: 'texto' },
  { tabela: 'AD_FORJATESTE', campo: 'QTD', descricao: 'Quantidade', tipo: 'inteiro' },
  { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', descricao: 'Situação', tipo: 'lista' },
];
const OPCOES = { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: [{ valor: 'A', descricao: 'Aberto' }, { valor: 'F', descricao: 'Fechado' }] };
const REQUERIDO = { tabela: 'AD_FORJATESTE', campo: 'DESCRICAO' };
const PASSOS = [
  { ferramenta: 'criar_tabela_ad', parametros: FORJATESTE },
  ...CAMPOS.map((parametros) => ({ ferramenta: 'criar_campo_ad', parametros })),
  { ferramenta: 'definir_opcoes_lista', parametros: OPCOES },
  { ferramenta: 'marcar_obrigatorio', parametros: REQUERIDO },
];

describe('critério de pronto (no mock): AD_FORJATESTE com 3 campos', () => {
  it('propor_plano → assinar → tabela + 3 passos de campo → conferir no dicionário → auditoria', async () => {
    const t = montarExecutor();

    // 1) o agente propõe o plano (não assina): um passo para a tabela, um por campo
    const prop = await t.executor.chamar('propor_plano', { id: 'forjateste', descricao: 'Criar AD_FORJATESTE', passos: PASSOS });
    expect(prop.isError, textoDe(prop)).toBeUndefined();
    expect(textoDe(prop)).toContain('forja-aprovar forjateste');

    // 2) sem assinatura, a criação é recusada e nada chega ao Sankhya
    const semAssinatura = await t.executor.chamar('criar_tabela_ad', { ...FORJATESTE, plano_id: 'forjateste', passo_id: 1 });
    expect(semAssinatura.isError).toBe(true);
    expect(textoDe(semAssinatura)).toMatch(/regra 2.*sem assinatura/);
    expect(t.gw.chamadas).toHaveLength(0);

    // 3) o usuário assina (forja-aprovar)
    gravarPlano(t.planos, assinarPlano(lerPlano(t.planos, 'forjateste')!, CHAVE, 'fulano', new Date()));

    // 4) tabela (só tabela + chave primária)
    const r = await t.executor.chamar('criar_tabela_ad', { ...FORJATESTE, plano_id: 'forjateste', passo_id: 1 });
    expect(r.isError, textoDe(r)).toBeUndefined();
    const dados = JSON.parse(textoDe(r));
    expect(dados.situacao).toBe('CRIADA E CONFERIDA NO DICIONÁRIO');
    for (const c of dados.capturas) expect(fs.existsSync(c)).toBe(true);

    // 5) um passo por campo
    for (const [i, c] of CAMPOS.entries()) {
      const rc = await t.executor.chamar('criar_campo_ad', { ...c, plano_id: 'forjateste', passo_id: i + 2 });
      expect(rc.isError, textoDe(rc)).toBeUndefined();
    }
    // 5b) uma ação por passo: opções da lista e "Requerido" em passos próprios
    const ro = await t.executor.chamar('definir_opcoes_lista', { ...OPCOES, plano_id: 'forjateste', passo_id: 5 });
    expect(ro.isError, textoDe(ro)).toBeUndefined();
    const rr = await t.executor.chamar('marcar_obrigatorio', { ...REQUERIDO, plano_id: 'forjateste', passo_id: 6 });
    expect(rr.isError, textoDe(rr)).toBeUndefined();
    expect(t.construtor.acoes).toEqual([
      'criarTabela AD_FORJATESTE',
      'criarCampo AD_FORJATESTE.DESCRICAO',
      'criarCampo AD_FORJATESTE.QTD',
      'criarCampo AD_FORJATESTE.SITUACAO',
      'incluirOpcoes AD_FORJATESTE.SITUACAO A,F',
      'marcarRequerido AD_FORJATESTE.DESCRICAO',
    ]);

    // 6) conferência independente pelo dicionário
    const dic = JSON.parse(textoDe(await t.executor.chamar('ler_dicionario', { tabela: 'AD_FORJATESTE' })));
    expect(dic.existe).toBe(true);
    expect(dic.dicionario.TIPONUMERACAO).toBe('A');
    expect(dic.chavePrimaria).toEqual(['ID']);
    expect(dic.colunas.map((c: { COLUMN_NAME: string }) => c.COLUMN_NAME)).toEqual(['ID', 'DESCRICAO', 'QTD', 'SITUACAO']);
    expect(dic.opcoes).toHaveLength(2);
    expect(dic.atributos).toEqual([{ NOMECAMPO: 'DESCRICAO', NOME: 'requerido', VALOR: 'S' }]);

    // 7) o passo não roda duas vezes
    const repete = await t.executor.chamar('criar_tabela_ad', { ...FORJATESTE, plano_id: 'forjateste', passo_id: 1 });
    expect(textoDe(repete)).toMatch(/já foi executado/);

    const ev = t.eventos();
    const criacao = ev.find((e) => e.ferramenta === 'criar_tabela_ad' && e.resultado === 'aceito')!;
    expect(criacao.motivo).toBe('executado');
    expect(criacao.plano_id).toBe('forjateste');
    expect(criacao.passo_id).toBe(1);
    expect(criacao.captura_path).toBeTruthy();
    expect(JSON.parse(criacao.antes_json!).existe).toBe(false);
    expect(JSON.parse(criacao.depois_json!).existe).toBe(true);
    expect(ev.map((e) => `${e.ferramenta}:${e.resultado}`)).toEqual([
      'propor_plano:aceito',
      'criar_tabela_ad:recusado',
      'criar_tabela_ad:aceito',
      'criar_campo_ad:aceito',
      'criar_campo_ad:aceito',
      'criar_campo_ad:aceito',
      'definir_opcoes_lista:aceito',
      'marcar_obrigatorio:aceito',
      'ler_dicionario:aceito',
      'criar_tabela_ad:recusado',
    ]);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(t.auditoria.passoExecutado('forjateste', n)).toBe(true);
  });

  it('propor_plano recusa criar_tabela_ad com campos dentro', async () => {
    const t = montarExecutor();
    const r = await t.executor.chamar('propor_plano', {
      id: 'antigo',
      descricao: 'formato antigo',
      passos: [{ ferramenta: 'criar_tabela_ad', parametros: { ...FORJATESTE, campos: [CAMPOS[0]] } }],
    });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/cada campo vira um passo criar_campo_ad/);
    expect(fs.existsSync(`${t.planos}/antigo.json`)).toBe(false);
  });
});

describe('criar_campo_ad é seguro para repetir', () => {
  const prepara = () => {
    const t = montarExecutor();
    t.gw.base.criarTabela('AD_FORJATESTE', 'Teste Forja');
    t.gw.base.criarCampo('AD_FORJATESTE', 'QTD', 'Quantidade', 'inteiro');
    return t;
  };

  it('campo já existente com o mesmo tipo: "já existia", nada é mexido, passo conta como executado', async () => {
    const t = prepara();
    const campo = { tabela: 'AD_FORJATESTE', campo: 'QTD', descricao: 'Quantidade', tipo: 'inteiro' };
    planoAssinado(t.planos, 'q', [{ ferramenta: 'criar_campo_ad', parametros: campo }]);
    const r = await t.executor.chamar('criar_campo_ad', { ...campo, plano_id: 'q', passo_id: 1 });
    expect(r.isError, textoDe(r)).toBeUndefined();
    expect(JSON.parse(textoDe(r)).situacao).toMatch(/JÁ EXISTIA/);
    expect(t.construtor.acoes).toHaveLength(0);
    expect(t.eventos().at(-1)).toMatchObject({ resultado: 'aceito', motivo: 'já existia' });
    expect(t.auditoria.passoExecutado('q', 1)).toBe(true);
  });

  it('campo já existente com outro tipo: recusado, nada é mexido', async () => {
    const t = prepara();
    const campo = { tabela: 'AD_FORJATESTE', campo: 'QTD', descricao: 'Quantidade', tipo: 'data_hora' };
    planoAssinado(t.planos, 'q', [{ ferramenta: 'criar_campo_ad', parametros: campo }]);
    const r = await t.executor.chamar('criar_campo_ad', { ...campo, plano_id: 'q', passo_id: 1 });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/já existe em AD_FORJATESTE com outra definição/);
    expect(t.construtor.acoes).toHaveLength(0);
    expect(t.eventos().at(-1)!.resultado).toBe('recusado');
    expect(t.auditoria.passoExecutado('q', 1)).toBe(false);
  });
});

it('criar_campo_ad não aceita mais opcoes nem obrigatorio (uma ação por passo)', async () => {
  const t = montarExecutor();
  for (const extra of [{ opcoes: [{ valor: 'A', descricao: 'Ativo' }] }, { obrigatorio: true }]) {
    const r = await t.executor.chamar('propor_plano', {
      id: 'misturado',
      descricao: 'campo com extras',
      passos: [{ ferramenta: 'criar_campo_ad', parametros: { ...CAMPOS[2], ...extra } }],
    });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/parâmetros inválidos/);
  }
  expect(fs.existsSync(`${t.planos}/misturado.json`)).toBe(false);
});

describe('definir_opcoes_lista: uma ação, segura para repetir', () => {
  const OPCOES = [
    { valor: 'A', descricao: 'Ativo' },
    { valor: 'I', descricao: 'Inativo' },
  ];
  const prepara = () => {
    const t = montarExecutor();
    t.gw.base.criarTabela('AD_FORJATESTE', 'Teste Forja');
    t.gw.base.criarCampo('AD_FORJATESTE', 'SITUACAO', 'Situação', 'lista');
    t.gw.base.criarCampo('AD_FORJATESTE', 'OBS', 'Observação', 'texto');
    return t;
  };
  const rodar = async (t: ReturnType<typeof prepara>, parametros: Record<string, unknown>) => {
    planoAssinado(t.planos, 'o', [{ ferramenta: 'definir_opcoes_lista', parametros }]);
    return t.executor.chamar('definir_opcoes_lista', { ...parametros, plano_id: 'o', passo_id: 1 });
  };

  it('sem plano assinado: recusado na regra 2, nada enviado', async () => {
    const t = prepara();
    const r = await t.executor.chamar('definir_opcoes_lista', { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: OPCOES });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/regra 2/);
    expect(t.gw.chamadas).toHaveLength(0);
  });

  it('inclui só as que faltam e confere em TDDOPC', async () => {
    const t = prepara();
    t.gw.base.incluirOpcoes('AD_FORJATESTE', 'SITUACAO', [OPCOES[0]!]);
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: OPCOES });
    expect(r.isError, textoDe(r)).toBeUndefined();
    const d = JSON.parse(textoDe(r));
    expect(d.situacao).toBe('OPÇÕES INCLUÍDAS E CONFERIDAS EM TDDOPC');
    expect(d.incluidas).toEqual(['I']);
    expect(d.ja_existiam).toEqual(['A']);
    expect(t.construtor.acoes).toEqual(['incluirOpcoes AD_FORJATESTE.SITUACAO I']);
    expect(t.eventos().at(-1)).toMatchObject({ resultado: 'aceito', motivo: 'executado' });
  });

  it('todas iguais: "já existia", nada é mexido, passo conta como executado', async () => {
    const t = prepara();
    t.gw.base.incluirOpcoes('AD_FORJATESTE', 'SITUACAO', OPCOES);
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: OPCOES });
    expect(JSON.parse(textoDe(r)).situacao).toMatch(/JÁ EXISTIA/);
    expect(t.construtor.acoes).toHaveLength(0);
    expect(t.eventos().at(-1)).toMatchObject({ resultado: 'aceito', motivo: 'já existia' });
    expect(t.auditoria.passoExecutado('o', 1)).toBe(true);
  });

  it('mesmo valor com outra descrição: recusado, nada é mexido', async () => {
    const t = prepara();
    t.gw.base.incluirOpcoes('AD_FORJATESTE', 'SITUACAO', [{ valor: 'A', descricao: 'Aberto' }]);
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: OPCOES });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/"A" já existe como "Aberto"/);
    expect(t.construtor.acoes).toHaveLength(0);
    expect(t.auditoria.passoExecutado('o', 1)).toBe(false);
  });

  it('campo que não é lista ou não existe: recusado', async () => {
    for (const campo of ['OBS', 'NADA']) {
      const t = prepara();
      const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo, opcoes: OPCOES });
      expect(r.isError).toBe(true);
      expect(textoDe(r)).toMatch(campo === 'OBS' ? /não é do tipo lista/ : /não existe/);
      expect(t.construtor.acoes).toHaveLength(0);
    }
  });

  it('tela "confirma" mas TDDOPC não muda: erro de conferência', async () => {
    const t = prepara();
    t.construtor.naoGravarJanela = true;
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: OPCOES });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/TDDOPC divergiu/);
    expect(t.eventos().at(-1)!.captura_path).toBeTruthy();
  });

  it('valor repetido no pedido e tabela nativa: recusados pelo porteiro', async () => {
    const t = prepara();
    const rep = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'SITUACAO', opcoes: [OPCOES[0], OPCOES[0]] });
    expect(textoDe(rep)).toMatch(/regra 7.*repetido/s);
    const nativa = await rodar(t, { tabela: 'TGFCAB', campo: 'SITUACAO', opcoes: OPCOES });
    expect(textoDe(nativa)).toMatch(/regra 5/);
    expect(t.construtor.acoes).toHaveLength(0);
  });
});

describe('marcar_obrigatorio: uma ação, segura para repetir', () => {
  const prepara = () => {
    const t = montarExecutor();
    t.gw.base.criarTabela('AD_FORJATESTE', 'Teste Forja');
    t.gw.base.criarCampo('AD_FORJATESTE', 'OBS', 'Observação', 'texto');
    return t;
  };
  const rodar = async (t: ReturnType<typeof prepara>, parametros: Record<string, unknown>) => {
    planoAssinado(t.planos, 'r', [{ ferramenta: 'marcar_obrigatorio', parametros }]);
    return t.executor.chamar('marcar_obrigatorio', { ...parametros, plano_id: 'r', passo_id: 1 });
  };

  it('marca e confere em TDDPCO', async () => {
    const t = prepara();
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'OBS' });
    expect(r.isError, textoDe(r)).toBeUndefined();
    expect(JSON.parse(textoDe(r)).situacao).toBe('REQUERIDO MARCADO E CONFERIDO EM TDDPCO');
    expect(t.construtor.acoes).toEqual(['marcarRequerido AD_FORJATESTE.OBS']);
  });

  it('já requerido: "já existia", nada é mexido', async () => {
    const t = prepara();
    t.gw.base.marcarRequerido('AD_FORJATESTE', 'OBS');
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'OBS' });
    expect(JSON.parse(textoDe(r)).situacao).toMatch(/JÁ EXISTIA/);
    expect(t.construtor.acoes).toHaveLength(0);
    expect(t.auditoria.passoExecutado('r', 1)).toBe(true);
  });

  it('tela "confirma" mas TDDPCO não muda: erro de conferência', async () => {
    const t = prepara();
    t.construtor.naoGravarJanela = true;
    const r = await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'OBS' });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/TDDPCO divergiu/);
    expect(t.auditoria.passoExecutado('r', 1)).toBe(false);
  });

  it('campo inexistente: recusado; tabela nativa: regra 5', async () => {
    const t = prepara();
    expect(textoDe(await rodar(t, { tabela: 'AD_FORJATESTE', campo: 'NADA' }))).toMatch(/não existe/);
    expect(textoDe(await rodar(t, { tabela: 'TGFPAR', campo: 'OBS' }))).toMatch(/regra 5/);
    expect(t.construtor.acoes).toHaveLength(0);
  });
});

describe('passo de plano: duas chamadas simultâneas', () => {
  it('só uma executa; a outra é recusada na regra 2 ("já está em execução")', async () => {
    const t = montarExecutor();
    t.gw.base.criarTabela('AD_FORJATESTE', 'Teste Forja');
    t.gw.base.criarCampo('AD_FORJATESTE', 'OBS', 'Observação', 'texto');
    const parametros = { tabela: 'AD_FORJATESTE', campo: 'OBS' };
    planoAssinado(t.planos, 'dup', [{ ferramenta: 'marcar_obrigatorio', parametros }]);
    const chamada = () => t.executor.chamar('marcar_obrigatorio', { ...parametros, plano_id: 'dup', passo_id: 1 });
    const [a, b] = await Promise.all([chamada(), chamada()]);
    expect(a.isError, textoDe(a)).toBeUndefined();
    expect(b.isError).toBe(true);
    expect(textoDe(b)).toMatch(/regra 2.*já está em execução/s);
    expect(t.construtor.acoes).toEqual(['marcarRequerido AD_FORJATESTE.OBS']);
    // terminado o primeiro, a reserva é solta e a regra 2 normal ("já executado") assume
    expect(textoDe(await chamada())).toMatch(/regra 2/);
    expect(t.construtor.acoes).toHaveLength(1);
  });
});

describe('critério de pronto (no mock): duas ações proibidas', () => {
  it('estrutura na TGFCAB: recusada, nada enviado, registrada com motivo', async () => {
    const t = montarExecutor();
    const campo = { tabela: 'TGFCAB', campo: 'FORJA', tipo: 'texto' };
    // mesmo com plano assinado à mão pelo usuário
    planoAssinado(t.planos, 'cab', [{ ferramenta: 'criar_campo_ad', parametros: campo }]);
    const r = await t.executor.chamar('criar_campo_ad', { ...campo, plano_id: 'cab', passo_id: 1 });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/regra 5 – trava fixa.*tabelas adicionais/);
    expect(textoDe(r)).toMatch(/Nada foi enviado ao Sankhya/);
    expect(t.gw.chamadas).toHaveLength(0);
    expect(t.construtor.acoes).toHaveLength(0);
    const [e] = t.eventos();
    expect(e).toMatchObject({ ferramenta: 'criar_campo_ad', resultado: 'recusado', plano_id: 'cab', passo_id: 1 });
    expect(e!.motivo).toMatch(/\[regra 5 – trava fixa\] Estrutura só pode/);
  });

  it('SQL que não é SELECT: recusado, nada enviado, registrado com motivo', async () => {
    const t = montarExecutor();
    const r = await t.executor.chamar('consultar_sql', { sql: 'DELETE FROM AD_FORJATESTE' });
    expect(r.isError).toBe(true);
    expect(t.gw.chamadas).toHaveLength(0);
    const [e] = t.eventos();
    expect(e).toMatchObject({ ferramenta: 'consultar_sql', resultado: 'recusado', usuario: 'fulano', perfil: 'desenvolvedor' });
    expect(e!.motivo).toMatch(/\[regra 5 – trava fixa\] Só leitura \(SELECT\).*DELETE/);
    expect(JSON.parse(e!.parametros)).toEqual({ sql: 'DELETE FROM AD_FORJATESTE' });
  });

  it('propor_plano também recusa passo proibido', async () => {
    const t = montarExecutor();
    const r = await t.executor.chamar('propor_plano', {
      id: 'ruim',
      descricao: 'x',
      passos: [{ ferramenta: 'criar_campo_ad', parametros: { tabela: 'TGFCAB', campo: 'X', tipo: 'texto' } }],
    });
    expect(r.isError).toBe(true);
    expect(fs.existsSync(`${t.planos}/ruim.json`)).toBe(false);
  });
});

describe('trava de base no executor', () => {
  it('usuário de banco diferente: erro, encerra, e nada mais roda', async () => {
    const t = montarExecutor();
    t.gw.base.usuario = 'SANKHYA';
    const r = await t.executor.chamar('ler_dicionario', { tabela: 'TGFPAR' });
    expect(r.isError).toBe(true);
    expect(textoDe(r)).toMatch(/TRAVA DE AMBIENTE.*SANKHYA/);
    expect(t.encerrados).toHaveLength(1);
    expect(t.gw.chamadas).toHaveLength(1); // só o SELECT USER FROM DUAL
    const depois = await t.executor.chamar('ler_dicionario', { tabela: 'TGFPAR' });
    expect(textoDe(depois)).toMatch(/RECUSADO: TRAVA DE AMBIENTE/);
    expect(t.gw.chamadas).toHaveLength(1);
    expect(t.eventos().map((e) => e.resultado)).toEqual(['erro', 'recusado']);
  });
  it('confere a base uma vez só', async () => {
    const t = montarExecutor();
    await t.executor.chamar('ler_dicionario', { tabela: 'TGFPAR' });
    await t.executor.chamar('ler_dicionario', { tabela: 'TGFCAB' });
    expect(t.gw.chamadas.filter((c) => c.detalhe === 'SELECT USER AS USUARIO FROM DUAL')).toHaveLength(1);
  });
});

describe('gravar_registros: prévia + token + aprovação de passo', () => {
  const prepara = () => {
    const t = montarExecutor();
    t.gw.base.criarTabela('AD_FORJATESTE', 'Teste');
    t.gw.base.criarCampo('AD_FORJATESTE', 'DESCRICAO', 'Descrição', 'texto');
    return t;
  };
  const params = { entidade: 'AD_FORJATESTE', registros: [{ valores: { DESCRICAO: 'primeiro' } }] };

  it('sem aprovação do passo: regra 4', async () => {
    const t = prepara();
    planoAssinado(t.planos, 'g', [{ ferramenta: 'gravar_registros', parametros: params }]);
    const r = await t.executor.chamar('gravar_registros', { ...params, plano_id: 'g', passo_id: 1 });
    expect(textoDe(r)).toMatch(/regra 4/);
    expect(t.gw.gravacoes).toHaveLength(0);
  });

  it('prévia não grava; token grava uma vez; token não serve duas vezes', async () => {
    const t = prepara();
    planoAssinado(t.planos, 'g', [{ ferramenta: 'gravar_registros', parametros: params }], [1]);
    const chamada = { ...params, plano_id: 'g', passo_id: 1 };

    const previa = JSON.parse(textoDe(await t.executor.chamar('gravar_registros', chamada)));
    expect(previa.situacao).toMatch(/PRÉVIA/);
    expect(previa.codigo_confirmacao).toMatch(/^[0-9a-f]{32}$/);
    expect(t.gw.gravacoes).toHaveLength(0);

    const token = previa.codigo_confirmacao;
    const errado = await t.executor.chamar('gravar_registros', { ...chamada, token_confirmacao: '0'.repeat(32) });
    expect(errado.isError).toBe(true);
    expect(t.gw.gravacoes).toHaveLength(0);

    const grava = await t.executor.chamar('gravar_registros', { ...chamada, token_confirmacao: token });
    expect(grava.isError, textoDe(grava)).toBeUndefined();
    expect(JSON.parse(textoDe(grava)).situacao).toBe('GRAVADO');
    expect(t.gw.gravacoes).toHaveLength(1);
    expect(t.gw.base.tabelas.get('AD_FORJATESTE')!.registros).toEqual([{ ID: 1, DESCRICAO: 'primeiro' }]);

    const de_novo = await t.executor.chamar('gravar_registros', { ...chamada, token_confirmacao: token });
    expect(textoDe(de_novo)).toMatch(/já foi executado/);
    expect(t.gw.gravacoes).toHaveLength(1);

    const ev = t.eventos().map((e) => `${e.resultado}:${e.motivo.slice(0, 12)}`);
    expect(ev[0]).toBe('aceito:previa');
    expect(ev).toContain('aceito:executado');
    // o token não fica legível na auditoria
    expect(t.eventos().some((e) => e.parametros.includes(token))).toBe(false);
  });

  it('save "Não autorizado" vira erro registrado', async () => {
    const t = prepara();
    t.gw.falharSave = 'Não autorizado.';
    planoAssinado(t.planos, 'g', [{ ferramenta: 'gravar_registros', parametros: params }], [1]);
    const chamada = { ...params, plano_id: 'g', passo_id: 1 };
    const previa = JSON.parse(textoDe(await t.executor.chamar('gravar_registros', chamada)));
    const r = await t.executor.chamar('gravar_registros', { ...chamada, token_confirmacao: previa.codigo_confirmacao });
    expect(r.isError).toBe(true);
    expect(t.eventos().at(-1)).toMatchObject({ resultado: 'erro', motivo: 'Não autorizado.' });
  });
});

describe('outros caminhos do executor', () => {
  it('divergência na conferência vira erro com antes/depois', async () => {
    const t = montarExecutor();
    t.gw.base.criarTabela('AD_FORJATESTE', 'Teste');
    t.construtor.naoCriarCampo = true;
    const campo = { tabela: 'AD_FORJATESTE', campo: 'OBS', tipo: 'texto' };
    planoAssinado(t.planos, 'c', [{ ferramenta: 'criar_campo_ad', parametros: campo }]);
    const r = await t.executor.chamar('criar_campo_ad', { ...campo, plano_id: 'c', passo_id: 1 });
    expect(r.isError).toBe(true);
    const e = t.eventos().at(-1)!;
    expect(e.resultado).toBe('erro');
    expect(e.antes_json).toBeTruthy();
    expect(e.captura_path).toBeTruthy();
    // o passo não conta como executado: pode ser repetido depois de corrigir
    expect(t.auditoria.passoExecutado('c', 1)).toBe(false);
  });

  it('falha do navegador vira erro com captura_path, sem a mensagem do Playwright', async () => {
    const t = montarExecutor();
    t.construtor.falharTabela = true;
    const tabela = { nome: 'AD_FORJATESTE', descricao: 'Teste Forja', nome_pk: 'ID', descricao_pk: 'Código' };
    planoAssinado(t.planos, 'f', [{ ferramenta: 'criar_tabela_ad', parametros: tabela }]);
    const r = await t.executor.chamar('criar_tabela_ad', { ...tabela, plano_id: 'f', passo_id: 1 });
    expect(r.isError).toBe(true);
    const e = t.eventos().at(-1)!;
    expect(e.resultado).toBe('erro');
    expect(e.captura_path).toBeTruthy();
    expect(String(e.motivo)).not.toMatch(/Timeout|locator/);
    expect(t.auditoria.passoExecutado('f', 1)).toBe(false);
  });

  it('ferramenta desconhecida é recusada e registrada', async () => {
    const t = montarExecutor();
    const r = await t.executor.chamar('apagar_tudo', {});
    expect(r.isError).toBe(true);
    expect(t.eventos()[0]).toMatchObject({ ferramenta: 'apagar_tudo', resultado: 'recusado' });
  });

  it('consultar_sql mascara colunas sensíveis de um SELECT *', async () => {
    const t = montarExecutor();
    t.gw.responderSql = () => ({ columns: ['CODIGO', 'TOKENAPI'], rows: [[1, 'abc123']], truncated: false });
    const r = JSON.parse(textoDe(await t.executor.chamar('consultar_sql', { sql: 'SELECT * FROM AD_INTEGRACAO' })));
    expect(r.linhas).toEqual([[1, '***']]);
    expect(r.colunas_mascaradas).toEqual(['TOKENAPI']);
    expect(String(t.gw.chamadas.at(-1)!.detalhe)).toMatch(/WHERE ROWNUM <= 1001$/);
  });

  it('consultar_sql corta em 1000 linhas', async () => {
    const t = montarExecutor();
    t.gw.responderSql = () => ({ columns: ['N'], rows: Array.from({ length: 1001 }, (_, i) => [i]), truncated: false });
    const r = JSON.parse(textoDe(await t.executor.chamar('consultar_sql', { sql: 'SELECT N FROM AD_X' })));
    expect(r.total).toBe(1000);
    expect(r.truncado).toBe(true);
  });

  it('carregar_registros resolve a instância e filtra', async () => {
    const t = montarExecutor();
    const tab = t.gw.base.criarTabela('AD_FORJATESTE', 'Teste');
    t.gw.base.criarCampo('AD_FORJATESTE', 'DESCRICAO', 'Descrição', 'texto');
    tab.registros.push({ ID: 1, DESCRICAO: 'a' }, { ID: 2, DESCRICAO: 'b' });
    const r = JSON.parse(
      textoDe(
        await t.executor.chamar('carregar_registros', {
          entidade: 'AD_FORJATESTE',
          campos: ['ID', 'DESCRICAO'],
          filtro: { expressao: 'this.ID = ?', parametros: [{ valor: 2, tipo: 'I' }] },
        }),
      ),
    );
    expect(r.registros).toEqual([{ ID: 2, DESCRICAO: 'b' }]);
  });
});
