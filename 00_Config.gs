/**
 * MONITOR DE INSTRUMENTOS COLETIVOS - EXEMPLO
 * 00_Config.gs  |  Configuracao central. Unico arquivo que se edita no dia a dia.
 *
 * NENHUMA credencial fica aqui. Todas ficam em Propriedades do Script:
 *   Extensoes > Apps Script > Configuracoes do projeto > Propriedades do script
 *
 * RECONSTRUIDO EM 14/08/2026 apos eu ter sobrescrito este arquivo por engano.
 * Confira PASTA_DRIVE_ID e SLACK_CANAL_ID antes de confiar.
 */

const CFG = {

  // ---------- Planilha base ----------
  // Drive Compartilhado Servidor IA > 2. Automacoes > Monitor CCTs
  PLANILHA_ID: 'ID_EXEMPLO',

  ABAS: {
    SINDICATOS:    '01_SINDICATOS',
    FONTES:        '02_FONTES',
    MONITORAMENTO: '03_MONITORAMENTO',
    CCTS:          '04_CCTS',
    FILA:          '05_FILA_VALIDACAO',
    EMPRESAS:      '10_EMPRESAS',
    DEPARA:        '12_DEPARA',
    ESTADO:        '09_ESTADO'          // criada automaticamente pelo Setup
  },

  LINHA_CABECALHO: 2,   // os dados comecam na linha 3

  // ---------- Drive ----------
  PASTA_DRIVE_ID: 'ID_EXEMPLO',   // Monitor CCTs > Documentos

  // ---------- Limites de execucao ----------
  // O Apps Script encerra em 6 minutos. Paramos antes e retomamos de onde parou.
  TEMPO_MAXIMO_MS: 4.5 * 60 * 1000,
  MAX_DOCUMENTOS_POR_EXECUCAO: 3,
  TAMANHO_MAXIMO_PDF_MB: 25,

  // ---------- IA ----------
  GEMINI_MODELO: 'gemini-3.6-flash',   // 18/08/2026: Google desativou o gemini-2.5-flash
  // Se o primeiro nao responder (404 = Google aposentou), o robo cai para o proximo
  // sozinho, grava qual passou a usar e avisa no Slack. Ver chamarGemini_ no 30_IA.gs.
  GEMINI_MODELOS_RESERVA: ['gemini-3.7-flash', 'gemini-3.5-flash'],
  CLAUDE_MODELO: 'claude-sonnet-4-5',

  // USAR_CLAUDE = false  -> auditoria 100% Gemini, custo zero, sem chave da Anthropic
  // USAR_CLAUDE = true   -> Claude audita; CLAUDE_SOMENTE_P1 decide se em tudo ou so no P1
  USAR_CLAUDE: false,
  CLAUDE_SOMENTE_P1: true,
  CONFIANCA_MINIMA: 0.80,

  // ---------- Regra de ouro ----------
  // Falso negativo e muito pior que falso positivo. Na duvida, alerta.
  ALERTAR_EM_CASO_DE_DUVIDA: false,

  // Documento com vigencia ja encerrada nao vira alerta - so entra no log de
  // monitoramento. Foi o que encheu o canal com CCT de 2024 quando um sindicato
  // reorganizou o site. Ligar em true se algum dia quiser recuperar o acervo.
  // true = NAO filtra por vigencia. Convencao publicada hoje costuma ter vigencia
  // retroativa; cortar pela data do documento sumiria justamente com a CCT nova.
  // Quem separa acervo de novidade e o 90_Acervo.gs (marco zero), nao a vigencia.
  ALERTAR_ACERVO_ANTIGO: true,

  // ---------- Slack ----------
  SLACK_CANAL_ID: 'ID_SLACK_EXEMPLO',   // #cct-alertas
  SLACK_EMOJI: { confirmar: 'white_check_mark', ignorar: 'x', revisar: 'warning' },

  // ---------- MTE / Mediador ----------
  MTE_AUTOMATICO: false,
  MTE_URL_CONSULTA: 'https://mediador.trabalho.gov.br/sistemas/mediador/ConsultarInstColetivo',

  // ---------- Operacao ----------
  EMAIL_ERROS: 'victoria.pedrosa@exemplo.com.br',   // recebe aviso quando uma fonte quebra

  // Fontes que falham SEMPRE e por decisao de fora: nao vale e-mail de incidente.
  // F62 (MTE / Sistema Mediador) devolve 403 porque o governo bloqueia acesso
  // automatizado - isso e esperado, a conferencia no Mediador e manual. A falha
  // continua registrada na aba 03_MONITORAMENTO, so nao vira e-mail.
  FONTES_SEM_AVISO_DE_FALHA: ['F62'],

            
  FUSO: 'America/Sao_Paulo'
};

/**
 * Nomes aceitos para cada credencial. Existe porque um nome divergente na
 * propriedade ja causou um find & replace que gravou o VALOR da chave dentro
 * do codigo. Agora o codigo se adapta ao nome cadastrado, e nao o contrario.
 */
const ALIAS_CREDENCIAL = {
  GEMINI_API_KEY:  ['GEMINI_API_KEY', 'GEMINI_KEY', 'API_KEY_GEMINI'],
  CLAUDE_API_KEY:  ['CLAUDE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_KEY'],
  SLACK_BOT_TOKEN: ['SLACK_BOT_TOKEN', 'SLACK_TOKEN', 'SLACK_XOXB'],
  SLACK_WEBHOOK:   ['SLACK_WEBHOOK', 'SLACK_WEBHOOK_URL']
};

/** Valor da credencial, testando todos os nomes aceitos. null se nao houver. */
function credencial_(chave) {
  const props = PropertiesService.getScriptProperties();
  const nomes = ALIAS_CREDENCIAL[chave] || [chave];
  for (var i = 0; i < nomes.length; i++) {
    const v = props.getProperty(nomes[i]);
    if (v) return v;
  }
  return null;
}

/** Igual ao credencial_, mas falha alto. Use quando a credencial for obrigatoria. */
function segredo_(chave) {
  const v = credencial_(chave);
  if (!v) {
    throw new Error('Credencial ausente nas Propriedades do Script. ' +
      'Cadastre com um destes nomes: ' + (ALIAS_CREDENCIAL[chave] || [chave]).join(' ou '));
  }
  return v;
}

/** Credenciais obrigatorias que estao faltando agora. */
function credenciaisFaltando_() {
  const faltando = [];
  if (!credencial_('GEMINI_API_KEY')) faltando.push('GEMINI_API_KEY (ou GEMINI_KEY)');
  if (CFG.USAR_CLAUDE && !credencial_('CLAUDE_API_KEY')) faltando.push('CLAUDE_API_KEY');
  if (!credencial_('SLACK_BOT_TOKEN') && !credencial_('SLACK_WEBHOOK')) {
    faltando.push('SLACK_BOT_TOKEN (ou SLACK_WEBHOOK)');
  }
  return faltando;
}
