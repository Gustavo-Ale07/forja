/**
 * Seletores das telas do Sankhya Om (versão 4.35b808, base de teste).
 *
 * CALIBRADO em 13/11/2026 (capturas em auditoria/capturas/calibracao-*):
 *   login em duas etapas, avisos de entrada, pesquisa do menu, Construtor de Telas (lista, filtro,
 *   registro aberto, aba Campos), Dicionario (lista) e, com clique supervisionado no "+", o
 *   assistente "Nova Tela" até o formulário da chave primária (combos Tipo/Apresentação incluídos).
 * Depois, provados em execução: assistente completo (forjateste) e formulário de novo campo
 *   (forjateste-campos). Calibrados sem gravar: janelas Opções e Atributos de campo existente.
 * NÃO PROVADO ainda: o "Salvar [F7]" da linha de Opções seguido de OK, e o OK de Atributos
 *   (a calibração terminou sempre em Cancelar). Cada passo que falhar deixa captura.
 */
export const SELETORES = {
  login: {
    /** 1ª etapa: usuário + "Prosseguir". 2ª etapa: senha + "Prosseguir". */
    usuario: '#user',
    senha: '#password',
    prosseguir: 'button.account-btn:has-text("Prosseguir"), button[type="submit"]:has-text("Prosseguir")',
    /** Só existe depois de logado. */
    logado: '#search-input-element',
  },
  /** Avisos ao entrar (shadow DOM): fecha-se só pelo botão "Cancelar". Nunca os X da barra de tarefas. */
  avisos: { cancelar: 'Cancelar' },
  menu: {
    pesquisa: '#search-input-element',
    /** `fill` não filtra: é preciso digitar tecla a tecla. */
    item: (nome: string) => `td.gwt-MenuItem.firstItem-MenuItem:has-text("${nome}")`,
  },
  construtor: {
    /** A tela roda num iframe (AngularJS) com URL /mge/CadastroTelasAdicionais.xhtml5. */
    iframe: 'iframe[title="Construtor de Telas"]',
    /** Barra da lista: "+" (tooltip "Adicionar nova tela"). */
    botaoNovaTela: 'button#btn-action[tooltip="Adicionar nova tela"]',
    /** Painel de filtro: inputs na ordem Nome da Tabela, Nome da Instância, Descrição da tela. */
    filtroTabela: 'input.form-control >> nth=0',
    aplicar: 'button:has-text("Aplicar")',
    abaCampos: 'Campos',
    abaLigacoes: 'Ligações',
    /** Botão do modo edição da aba Campos; some quando o salvamento termina. */
    descartar: 'Descartar',
    /** Barra da aba Campos: o "+" é o 2º button.btn-novo-registro (o 1º é o "Filtro"). */
    botaoNovoCampo: 'button.btn-novo-registro >> nth=1',
    botaoAtributos: 'button:has-text("Atributos")',

    // ---- assistente "Nova Tela" (calibrado até a chave primária) ----
    novaSolucao: 'Nova Solução',
    tipoTelaMestre: 'Tela mestre',
    /** Rodapé do assistente: Cancelar / Anterior / Próximo / Concluir (botões de texto). */
    proximo: 'Próximo',
    concluir: 'Concluir',
    marcadorChavePrimaria: 'Informe a chave primária',
    marcadorAutoNumeracao: 'Selecione um campo para utilizar a auto numeração',
    /** "+" da grade da PK (tooltip "Cadastrar Descrição de Campos [F8]"); a grade abre vazia. */
    adicionarLinhaPk: '.modal button.btn-novo-registro',
    /** ✓ da grade (tooltip "Salvar [F7]"). Sem salvar a linha, o "Próximo" fica desabilitado. */
    salvarLinhaPk: '.modal button:has(span.glyphicons-ok-2)',
    /** Rótulos (<span.lblText> de <sk-simple-item>); o Sankhya escreve "Apresentacão" (com c). */
    rotuloDescricaoInstancia: 'Descrição da Instância',
    rotuloNomeTabela: 'Nome da Tabela',
    rotuloNomeCampo: 'Nome do campo',
    rotuloDescricaoCampo: 'Descrição do campo',
    rotuloTipoCampo: /^\s*Tipo de dados:?\s*$/i,
    rotuloApresentacao: /^\s*Apresenta[cç][aã]o:?\s*$/i,
    rotuloAutoNumeracao: /^\s*Auto numera[cç][aã]o:?\s*$/i,

    // ---- aba Campos de registro existente (calibrado em 13/11/2026: calibracao-opcoes-atributos-*) ----
    /** ✓ "Salvar [F7]" do formulário de campo (provado no forjateste-campos). */
    salvarCampo: 'button:has(span.glyphicons-ok-2)',
    /** A aba Campos abre em GRADE; duplo clique na linha abre o formulário do campo. */
    botaoPrimeiro: 'button[tooltip="Primeiro"]',
    botaoProximo: 'button[tooltip^="Próximo"]',
    /** Botões de texto da barra da aba Campos (o "Opções" só aparece em campo lista). */
    botaoOpcoesTexto: 'Opções',
    botaoAtributosTexto: 'Atributos',

    // ---- janelas Opções e Atributos (.modal visível) ----
    janela: '.modal',
    /** "+" da janela Opções (tooltip "Cadastrar OpcaoCampo [F8]"): abre o formulário da linha. */
    novaLinhaJanela: 'button.btn-novo-registro',
    /** Rótulos do formulário da linha: "Valor: *" e "Descrição do formulário: *". */
    rotuloValorOpcao: /^\s*Valor/i,
    rotuloDescricaoOpcao: /^\s*Descri/i,
    /** ✓ "Salvar [F7]" da linha da janela. */
    salvarLinhaJanela: 'button:has(span.glyphicons-ok-2)',
    /** Rodapé das janelas: "Cancelar" (btn-popup-cancel) / "OK" (btn-popup-ok). */
    okJanela: 'button.btn-popup-ok',
    /** Janela "Atributos de campo adicional": interruptor <sk-switch> do Requerido. */
    interruptorRequerido: 'sk-switch[sk-value="ctrl.requerido"]',
  },
  /** Opção do combo "Apresentação" por tipo (opções vistas: Lista de Opções, Formatação HTML, Checkbox, Padrão). */
  apresentacao: {
    texto: 'Padrão',
    lista: 'Lista de Opções',
    inteiro: 'Padrão',
    decimal: 'Padrão',
    data_hora: 'Padrão',
  },
} as const;

/** Salvar campo leva 15–20 s (ALTER TABLE). */
export const ESPERA_SALVAR_MS = 45_000;
