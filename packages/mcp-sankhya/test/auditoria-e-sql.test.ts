import { describe, expect, it } from 'vitest';
import { hojeNoFuso, intervaloDoDia, linhaAuditoria } from '../src/auditoria/registro.js';
import { erroNavegador, ForjaErro } from '../src/comum/erros.js';
import { mascarar, mascararTexto, mensagemSegura, registrarSegredo } from '../src/comum/mascara.js';
import { contarMarcadores, validarFiltro, validarSelect } from '../src/sql/validar.js';

describe('auditoria (formato da linha)', () => {
  it('mascara segredos nos parâmetros e no motivo', () => {
    registrarSegredo('valor-super-secreto');
    const l = linhaAuditoria({
      ambiente: 'teste',
      ferramenta: 'x',
      parametros: { senha: 'abc', client_secret: 'def', ok: 'valor-super-secreto' },
      resultado: 'erro',
      motivo: 'falhou com Bearer eyJabc.def e valor-super-secreto',
    });
    expect(l.parametrosJson).not.toMatch(/abc|def|valor-super-secreto/);
    expect(l.motivo).not.toMatch(/eyJabc|valor-super-secreto/);
  });
  it('JSON grande é truncado', () => {
    const l = linhaAuditoria({ ambiente: 'teste', ferramenta: 'x', parametros: {}, resultado: 'aceito', motivo: 'm', antes: 'a'.repeat(300_000) });
    expect(JSON.parse(l.antesJson!)).toMatchObject({ truncado: true });
  });
  it('intervalo do dia no fuso de São Paulo', () => {
    expect(intervaloDoDia('2026-11-11', 'America/Sao_Paulo')).toEqual({ inicio: '2026-11-11T03:00:00.000Z', fim: '2026-11-12T03:00:00.000Z' });
    expect(hojeNoFuso('America/Sao_Paulo', new Date('2026-11-12T02:30:00Z'))).toBe('2026-11-11');
  });
});

describe('validarSelect', () => {
  const ok = (sql: string) => expect(validarSelect(sql), sql).toMatchObject({ ok: true });
  const nao = (sql: string, m?: RegExp) => {
    const r = validarSelect(sql);
    expect(r.ok, sql).toBe(false);
    if (!r.ok && m) expect(r.motivo).toMatch(m);
  };
  it('aceita SELECT e WITH', () => {
    ok('SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC = 1');
    ok('select p.codparc from tgfpar p join tgfcab c on c.codparc = p.codparc');
    ok('WITH A AS (SELECT 1 AS N FROM DUAL) SELECT N FROM A');
    ok("SELECT 'DELETE FROM X' AS TEXTO FROM DUAL");
  });
  it('recusa o resto', () => {
    nao('', /vazio/);
    nao('SELECT 1 FROM DUAL;', /";"/);
    nao('SELECT 1 FROM DUAL /* x */', /Comentários/);
    nao('INSERT INTO AD_X VALUES (1)');
    nao('BEGIN NULL; END');
    nao('SELECT DBMS_RANDOM.VALUE FROM DUAL');
    nao('SELECT * FROM TGFPAR WHERE CODPARC = 1 FOR UPDATE');
    nao('SELECT * FROM TGFPAR P, TGFCAB C WHERE P.CODPARC = C.CODPARC(+)', /\(\+\)/);
    nao('SELECT CHAVE FROM AD_X', /sensível/);
    nao('EXPLAIN PLAN FOR SELECT 1 FROM DUAL');
  });
  it('fecha os desvios da máscara por nome de coluna', () => {
    nao('SELECT CODPARC AS A FROM TGFPAR UNION SELECT * FROM AD_INTEGRACAO', /UNION/);
    nao('SELECT CODPARC FROM TGFPAR MINUS SELECT CODPARC FROM TGFCAB', /MINUS/);
    nao('SELECT CODPARC FROM TGFPAR INTERSECT SELECT CODPARC FROM TGFCAB', /INTERSECT/);
    nao('SELECT * FROM (SELECT * FROM AD_INTEGRACAO)', /"\*"/);
    nao('SELECT X.A FROM (SELECT I.* FROM AD_INTEGRACAO I) X', /"\*"/);
    nao('WITH X (A, B) AS (SELECT * FROM AD_INTEGRACAO) SELECT A, B FROM X', /"\*"/);
    nao('SELECT XMLTYPE(CURSOR(SELECT ID FROM AD_INTEGRACAO)) FROM DUAL', /XMLTYPE/);
    nao("SELECT EXTRACTVALUE(X, '/a') FROM AD_X", /EXTRACTVALUE/);
    nao('SELECT XMLSERIALIZE(CONTENT X) FROM AD_X', /XMLSERIALIZE/);
    nao("SELECT HTTPURITYPE('http://x').GETCLOB() FROM DUAL", /HTTPURITYPE/);
    nao('SELECT JSON_OBJECT(*) FROM AD_INTEGRACAO', /JSON_OBJECT/);
  });
  it('continua aceitando * no SELECT de fora, COUNT(*) e multiplicação', () => {
    ok('SELECT * FROM TGFPAR');
    ok('SELECT COUNT(*) FROM TGFPAR');
    ok('SELECT P.* FROM TGFPAR P');
    ok('SELECT SUM(QTDNEG * VLRUNIT) FROM TGFITE');
    ok('SELECT CODPARC FROM TGFPAR WHERE CODPARC IN (SELECT CODPARC FROM TGFCAB WHERE VLRNOTA * 2 > 10)');
    ok('SELECT (SELECT COUNT(*) FROM TGFCAB C WHERE C.CODPARC = P.CODPARC) AS N FROM TGFPAR P');
    ok('SELECT EXTRACT(YEAR FROM DTNEG) AS ANO FROM TGFCAB');
  });
  it('identifica as tabelas lidas', () => {
    const r = validarSelect('SELECT 1 FROM TGFPAR P JOIN TGFCAB C ON C.CODPARC = P.CODPARC');
    expect(r.ok && r.tabelas.sort()).toEqual(['TGFCAB', 'TGFPAR']);
  });
});

describe('filtro do CRUD', () => {
  it('conta marcadores fora de aspas', () => {
    expect(contarMarcadores("this.A = ? AND this.B = '?' AND this.C = ?")).toBe(2);
  });
  it('aceita filtro simples e recusa subconsulta e DML', () => {
    expect(validarFiltro('this.ID = ? AND this.NOME LIKE ?').ok).toBe(true);
    expect(validarFiltro('this.ID IN (SELECT 1 FROM DUAL)').ok).toBe(false);
    expect(validarFiltro('1=1; DELETE FROM X').ok).toBe(false);
    expect(validarFiltro('this.ID = 1 -- x').ok).toBe(false);
  });
});

describe('máscara', () => {
  it('mascara chaves sensíveis em qualquer profundidade', () => {
    expect(mascarar({ a: { SENHA: 'x', api_key: 'y', lista: [{ token: 'z' }] }, nome: 'ok' })).toEqual({
      a: { SENHA: '***', api_key: '***', lista: [{ token: '***' }] },
      nome: 'ok',
    });
  });
  it('mascara Bearer e pares chave=valor em texto', () => {
    expect(mascararTexto('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(mascararTexto('client_secret=xyz&password=123')).not.toMatch(/xyz|123/);
  });
  it('tira códigos de cor do terminal', () => {
    expect(mascararTexto('Call log:\n\u001b[2m  - waiting for x\u001b[22m')).toBe('Call log:\n  - waiting for x');
  });
});

describe('erro do navegador (ferramentas e CLI de calibração)', () => {
  const playwright = new Error('locator.click: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator(\'label:has-text("Apresentação")\')\u001b[22m');
  it('erro cru do Playwright vira frase fixa com o passo', () => {
    const m = mensagemSegura(erroNavegador(playwright, 'Próximo (tipo)', 'da calibração do assistente Nova Tela'));
    expect(m).toBe('Falha no passo "Próximo (tipo)" da calibração do assistente Nova Tela.');
    expect(m).not.toMatch(/locator|Timeout|Call log|\u001b/);
  });
  it('ForjaErro mantém a mensagem e ganha o passo e os detalhes', () => {
    const e = erroNavegador(new ForjaErro('CLIQUE_PROIBIDO', 'clique recusado'), 'Salvar', undefined, { capturaPath: 'c:/x' });
    expect(e).toMatchObject({ codigo: 'CLIQUE_PROIBIDO', message: 'clique recusado', detalhes: { passo: 'Salvar', capturaPath: 'c:/x' } });
  });
});
