import type { FrameLocator, Locator } from 'playwright';

/**
 * Combos do Construtor de Telas são <sk-combobox> (ui-select, tema selectize, append-to-body):
 * não há <input> visível para preencher. Abre-se clicando em `.selectize-input` do item do
 * formulário e escolhe-se a linha em `.ui-select-choices-row` (lista anexada ao body do iframe).
 * Calibrado em 13/11/2026 (auditoria/capturas/calibracao-nova-tela-*).
 */

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Item de formulário (<sk-simple-item>) visível cujo rótulo casa com `rotulo`. */
export function itemFormulario(f: FrameLocator, rotulo: RegExp): Locator {
  return f
    .locator('sk-simple-item')
    .filter({ has: f.locator('span.lblText', { hasText: rotulo }) })
    .filter({ visible: true })
    .last();
}

/** Linhas visíveis da lista aberta do combo. */
export function linhasCombo(f: FrameLocator): Locator {
  return f.locator('.ui-select-choices-row').filter({ visible: true });
}

/** Abre o combo do item e devolve os textos das opções (sem escolher nada). */
export async function abrirCombo(f: FrameLocator, rotulo: RegExp, timeout = 30_000): Promise<string[]> {
  await itemFormulario(f, rotulo).locator('.selectize-input').click({ timeout });
  await linhasCombo(f).first().waitFor({ state: 'visible', timeout });
  return (await linhasCombo(f).allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Abre o combo e clica na opção de texto exato. Nunca rola a lista. */
export async function escolherCombo(f: FrameLocator, rotulo: RegExp, opcao: string, timeout = 30_000): Promise<void> {
  const opcoes = await abrirCombo(f, rotulo, timeout);
  if (!opcoes.includes(opcao)) throw new Error(`opção "${opcao}" ausente no combo (${opcoes.join(', ')})`);
  await clicarOpcao(f, opcao, timeout);
}

/** Com o combo já aberto, clica na linha de texto exato. */
export async function clicarOpcao(f: FrameLocator, opcao: string, timeout = 30_000): Promise<void> {
  await linhasCombo(f)
    .filter({ hasText: new RegExp(`^\\s*${escapar(opcao)}\\s*$`) })
    .first()
    .click({ timeout });
}

/** Texto hoje selecionado no combo do item. */
export async function valorCombo(f: FrameLocator, rotulo: RegExp): Promise<string> {
  const t = await itemFormulario(f, rotulo).locator('.ui-select-match').first().textContent();
  return (t ?? '').replace(/\s+/g, ' ').trim();
}
