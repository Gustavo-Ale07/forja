import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ForjaErro } from '../comum/erros.js';
import { SELETORES } from './seletores.js';

export interface OpcoesSessao {
  /** FORJA_TESTE_URL (origem). O login acrescenta /mge/system.jsp. */
  url: string;
  hostPermitido: string;
  usuario: string;
  senha: string;
  visivel: boolean;
}

/**
 * Sessão Playwright presa ao host de teste: qualquer requisição de documento/XHR para outro host
 * *.sankhyacloud.com.br é abortada, e toda navegação é conferida. Produção nunca é alcançável.
 */
export class SessaoNavegador {
  private browser: Browser | undefined;
  private contexto: BrowserContext | undefined;
  private pagina: Page | undefined;
  private violacao: string | undefined;

  constructor(private readonly o: OpcoesSessao) {
    const u = new URL(o.url);
    if (u.hostname.toLowerCase() !== o.hostPermitido) {
      throw new ForjaErro('INICIO_RECUSADO', `URL do navegador fora do host permitido (${u.hostname}).`);
    }
  }

  private conferirHost(url: string): void {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    if (host.endsWith('sankhyacloud.com.br') && host !== this.o.hostPermitido) {
      this.violacao = `O navegador tentou ir para ${host}, fora do host permitido.`;
    }
  }

  async abrir(): Promise<Page> {
    if (this.pagina && !this.pagina.isClosed()) return this.pagina;
    this.browser = await chromium.launch({ headless: !this.o.visivel });
    this.contexto = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
    await this.contexto.route('**/*', (rota) => {
      const url = rota.request().url();
      this.conferirHost(url);
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        /* data:, about: */
      }
      if (host.endsWith('sankhyacloud.com.br') && host !== this.o.hostPermitido) return rota.abort();
      return rota.continue();
    });
    const p = await this.contexto.newPage();
    p.on('framenavigated', (f) => this.conferirHost(f.url()));
    this.pagina = p;
    await this.login(p);
    return p;
  }

  /** Lança se em algum momento houve tentativa de sair do host permitido. */
  garantirHost(): void {
    if (this.violacao) throw new ForjaErro('NAVEGADOR_HOST', this.violacao);
    const atual = this.pagina?.url();
    if (atual && atual.startsWith('http') && new URL(atual).hostname.toLowerCase() !== this.o.hostPermitido) {
      throw new ForjaErro('NAVEGADOR_HOST', `Página atual fora do host permitido.`);
    }
  }

  private async login(p: Page): Promise<void> {
    const base = this.o.url.endsWith('/') ? this.o.url : `${this.o.url}/`;
    await p.goto(new URL('mge/system.jsp', base).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    this.garantirHost();
    const s = SELETORES.login;
    try {
      // Etapa 1: usuário. Etapa 2: senha. Cada uma com "Prosseguir".
      await p.locator(s.usuario).first().fill(this.o.usuario, { timeout: 30_000 });
      await p.locator(s.prosseguir).first().click();
      await p.locator(s.senha).first().fill(this.o.senha, { timeout: 30_000 });
      await p.locator(s.prosseguir).first().click();
      await p.locator(s.logado).first().waitFor({ timeout: 60_000 });
    } catch {
      // Nunca repassa a mensagem do Playwright: ela pode conter o valor digitado.
      throw new ForjaErro('NAVEGADOR_LOGIN', 'Login no Sankhya de teste não confirmado (tela logada não apareceu).');
    }
    this.garantirHost();
    await p.waitForTimeout(5_000);
    await this.fecharAvisos(p);
  }

  /**
   * Fecha os avisos de entrada (ficam em shadow DOM) clicando só em "Cancelar".
   * Não clica em nenhum "X": os da barra de tarefas fecham telas abertas.
   */
  async fecharAvisos(p: Page): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const b = p.getByRole('button', { name: SELETORES.avisos.cancelar, exact: true }).filter({ visible: true }).first();
      if (!(await b.count())) return;
      await b.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await p.waitForTimeout(1_500);
    }
  }

  /** Abre uma tela pela pesquisa do menu (digitando tecla a tecla, que é o que filtra). */
  async abrirTela(p: Page, nome: string): Promise<void> {
    const pesquisa = p.locator(SELETORES.menu.pesquisa).first();
    await pesquisa.click();
    await pesquisa.fill('');
    await pesquisa.pressSequentially(nome, { delay: 60 });
    await p.locator(SELETORES.menu.item(nome)).first().click({ timeout: 15_000 });
    this.garantirHost();
  }

  async fechar(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.contexto = undefined;
    this.pagina = undefined;
  }
}
