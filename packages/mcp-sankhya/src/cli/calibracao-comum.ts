/**
 * Peças comuns aos CLIs de calibração supervisionada.
 *
 * `dumpNoNavegador` roda DENTRO da página (frame.evaluate): tem de ser autocontida.
 */

/** O que nunca se clica numa calibração: salvar, gravar, excluir, fechar, "X". */
export const PROIBIDO_CALIBRACAO =
  /concluir|salvar|gravar|excluir|remover|lixeira|fechar|glyphicons-(bin|remove|trash|delete|circle-remove)|×|^\s*x\s*$/i;

/** Lista de elementos visíveis (no assistente, se estiver aberto) + listas suspensas abertas. */
export function dumpNoNavegador(): unknown {
  const visivel = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const resumo = (el: Element) => {
    const h = el as HTMLInputElement;
    const r = el.getBoundingClientRect();
    const o: Record<string, unknown> = { tag: el.tagName.toLowerCase(), xy: `${Math.round(r.x)},${Math.round(r.y)}` };
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (txt && el.tagName !== 'SELECT') o.txt = txt.slice(0, 120);
    for (const a of ['id', 'type', 'title', 'tooltip', 'placeholder', 'role', 'ng-model', 'sk-field', 'name']) {
      const v = el.getAttribute(a);
      if (v) o[a] = v.slice(0, 80);
    }
    const cls = el.getAttribute('class');
    if (cls) o.cls = cls.slice(0, 90);
    if (h.tagName === 'INPUT' || h.tagName === 'TEXTAREA') {
      o.valor = h.type === 'password' ? '***' : h.value;
      if (h.type === 'checkbox' || h.type === 'radio') o.marcado = h.checked;
    }
    if (h.tagName === 'SELECT') o.opcoes = Array.from((el as HTMLSelectElement).options).map((x) => `${x.value}=${x.text}${x.selected ? ' *' : ''}`);
    if ((el as HTMLButtonElement).disabled || el.getAttribute('disabled') !== null) o.desabilitado = true;
    const icone = el.querySelector('[class*="glyphicons-"]');
    if (icone) o.icone = icone.getAttribute('class');
    return o;
  };
  const dialogos = Array.from(document.querySelectorAll('.modal, [role="dialog"], .modal-dialog')).filter(visivel);
  const raiz: ParentNode = dialogos.at(-1) ?? document;
  const seletor = 'h1,h2,h3,h4,h5,.modal-title,label,input,select,textarea,button,[role="option"],[role="radio"],[role="checkbox"],li';
  const itens = Array.from(raiz.querySelectorAll(seletor)).filter(visivel).slice(0, 400).map(resumo);
  const popups = Array.from(
    document.querySelectorAll('.dropdown-menu, .ui-select-choices, ul[role="listbox"], .select2-results, .typeahead, [class*="combo"] ul, [class*="list-options"]'),
  )
    .filter(visivel)
    .map((u) => ({ cls: u.getAttribute('class'), itens: Array.from(u.querySelectorAll('li, [role="option"]')).filter(visivel).map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim()) }));
  const html = dialogos.length ? (dialogos.at(-1) as Element).outerHTML.slice(0, 300_000) : '';
  return { dialogoAberto: dialogos.length > 0, itens, popups, html };
}


/** Textos de um elemento (texto, title, tooltip, aria-label, ícone), testados um a um. */
export function cliqueProibido(partes: string[], extra?: RegExp): boolean {
  return partes.some((p) => {
    const t = p.replace(/\s+/g, ' ').trim();
    return t !== '' && (PROIBIDO_CALIBRACAO.test(t) || (extra?.test(t) ?? false));
  });
}
