/**
 * 80_Operacao.gs  |  Botoes manuais do operador.
 *
 * O seletor de funcoes do editor lista so as funcoes do arquivo aberto e escolhe
 * a PRIMEIRA como padrao; funcoes com _ no fim nem aparecem. Por isso as acoes
 * manuais moram aqui, com a mais usada em primeiro lugar: abrir o arquivo e
 * clicar em Executar ja roda a certa.
 */

/**
 * Le as reacoes do Slack agora e grava as decisoes na fila de validacao.
 * Antes de ler, conserta os timestamps corrompidos (ver repararTs_).
 */
function lerReacoesAgora() {
  const consertados = repararTs_();
  const n = coletarDecisoes_();

  // Diagnostico junto do resultado: zero sem explicacao ja custou tempo demais.
  const linhas = lerAba_(CFG.ABAS.FILA);
  const cab = Object.keys(linhas[0] || {}).filter(function (k) { return k !== '_linha'; });
  const detalhe = linhas.map(function (l) {
    return l['ID Alerta'] + ' ts=[' + (l['Slack TS'] || '') + ']' +
           ' decisao=[' + (l['Decisão humana'] || '') + ']';
  });

  const msg = [
    'Timestamps corrigidos: ' + consertados,
    'Decisoes gravadas: ' + n,
    'Linhas na fila: ' + linhas.length,
    'Colunas: ' + cab.join(' | '),
    detalhe.join('\n')
  ].join('\n');
  Logger.log(msg);
  return msg;
}

function repararTs_() {
  const hist = slackApi_('conversations.history',
                         { channel: CFG.SLACK_CANAL_ID, limit: 200 });
  if (!hist || !hist.ok || !hist.messages) return 0;

  const porAlerta = {};
  hist.messages.forEach(function (m) {
    // O ID do alerta fica no rodape, dentro de blocks - o campo text guarda so
    // o resumo curto da notificacao. Procurar so em m.text nao acha nada.
    const corpo = String(m.text || '') + ' ' + JSON.stringify(m.blocks || []);
    const achado = corpo.match(/Alerta\s+(ALT\d+)/);
    if (achado && !porAlerta[achado[1]]) porAlerta[achado[1]] = m.ts;
  });

  const ws = aba_(CFG.ABAS.FILA);
  const linhas = lerAba_(CFG.ABAS.FILA);
  var corrigidos = 0;

  linhas.forEach(function (l) {
    if (l['Decisão humana']) return;
    const certo = porAlerta[l['ID Alerta']];
    if (!certo) return;
    if (String(l['Slack TS']) === certo) return;   // ja esta correto
    const cel = ws.getRange(l._linha, 12);
    cel.setNumberFormat('@');
    cel.setValue(certo);
    corrigidos++;
  });

  return corrigidos;
}

/**
 * Apaga os registros de teste da fila. A fila e base de aprendizado do monitor;
 * registro ficticio estraga a metrica de acerto la na frente.
 */
function limparTestesDaFila() {
  const ws = aba_(CFG.ABAS.FILA);
  const linhas = lerAba_(CFG.ABAS.FILA);
  var apagadas = 0;
  for (var i = linhas.length - 1; i >= 0; i--) {   // de baixo para cima
    const ent = String(linhas[i]['Entidade'] || '').toUpperCase();
    if (ent.indexOf('TESTE') > -1) { ws.deleteRow(linhas[i]._linha); apagadas++; }
  }
  const msg = apagadas + ' linha(s) de teste removida(s) da fila.';
  Logger.log(msg);
  return msg;
}

/** Situacao do monitor em uma olhada. */
function comoEstaOMonitor() {
  const p = PropertiesService.getScriptProperties();
  const s = {
    ultimaExecucao: p.getProperty('ULTIMA_EXECUCAO') || 'nunca rodou',
    cursor: p.getProperty('CURSOR') || '0',
    fontesAtivas: carregarFontes_().length,
    mencionando: p.getProperty('SLACK_MENCIONAR') || 'ID_SLACK_EXEMPLO',
    gatilhos: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); })
  };
  Logger.log(JSON.stringify(s, null, 2));
  return s;
}
