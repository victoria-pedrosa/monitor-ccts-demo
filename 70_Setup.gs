/**
 * 70_Setup.gs  |  Instalação e operação. Rodar uma vez, na mão.
 */

/**
 * Confere se a base foi importada certa. Rodar ANTES do instalar().
 * A planilha vazia foi criada em 13/08/2026; o conteúdo entra por
 * Arquivo > Importar > Substituir planilha, usando MONITOR_CCT_BASE_EXEMPLO.xlsx.
 */
function conferirBase() {
  const ss = abrir_();
  const esperadas = [CFG.ABAS.SINDICATOS, CFG.ABAS.FONTES, CFG.ABAS.MONITORAMENTO,
                     CFG.ABAS.CCTS, CFG.ABAS.FILA];
  const faltando = esperadas.filter(function (n) { return !ss.getSheetByName(n); });
  if (faltando.length) {
    const msg = '❌ Abas faltando: ' + faltando.join(', ') +
                '\nImporte o MONITOR_CCT_BASE_EXEMPLO.xlsx em Arquivo > Importar > Substituir planilha.';
    Logger.log(msg); return msg;
  }
  const msg = '✅ Base OK — ' + lerAba_(CFG.ABAS.SINDICATOS).length + ' sindicatos e ' +
              carregarFontes_().length + ' fontes carregadas da planilha.';
  Logger.log(msg); return msg;
}

/**
 * Confere a ligacao entre a carteira (10_EMPRESAS) e o cadastro (01_SINDICATOS) via 12_DEPARA.
 * So leitura: nao notifica ninguem, nao grava nada. Rodar depois de editar o 12_DEPARA.
 */
function conferirEmpresas() {
  const empresas = carregarEmpresas_();
  const mapa = carregarDePara_();
  const cont = {};
  let semDePara = 0, naoNotificar = 0, pendentes = 0;

  empresas.forEach(function (e) {
    const d = mapa[chaveRotulo_(e['Sindicato Laboral'])];
    if (!d) { semDePara++; return; }
    if (d.notificar === 'NAO') { naoNotificar++; return; }
    if (d.notificar !== 'SIM') pendentes++;
    d.ids.forEach(function (id) { cont[id] = (cont[id] || 0) + 1; });
  });

  const ordenado = Object.keys(cont).sort(function (a, b) { return cont[b] - cont[a]; });
  const msg = empresas.length + ' empresas na carteira | ' +
              ordenado.length + ' sindicatos com pelo menos 1 cliente | ' +
              pendentes + ' empresas em linha CONFERIR | ' +
              naoNotificar + ' marcadas para nao notificar | ' +
              semDePara + ' sem de-para' +
              '\nTop 8: ' + ordenado.slice(0, 8).map(function (k) { return k + '=' + cont[k]; }).join(', ');
  Logger.log(msg);
  return msg;
}

/** PASSO ÚNICO DE INSTALAÇÃO. Rodar depois de conferirBase(). */
function instalar() {
  const ss = abrir_();

  // aba de estado (memória do robô)
  if (!ss.getSheetByName(CFG.ABAS.ESTADO)) {
    const ws = ss.insertSheet(CFG.ABAS.ESTADO);
    ws.getRange(1, 1).setValue('ESTADO DO MONITOR — não editar à mão');
    ws.getRange(2, 1, 1, 7).setValues([[
      'Chave', 'URL documento', 'Hash', 'Bytes', 'Última verificação', 'HTTP', 'Observação']]);
    ws.getRange(2, 1, 1, 7).setFontWeight('bold');
    ws.setFrozenRows(2);
  }

  // gatilhos
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'rodarMonitor') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rodarMonitor').timeBased().everyHours(1).create();

  // conferência das credenciais
  const props = PropertiesService.getScriptProperties();
  const faltando = ['GEMINI_KEY'].filter(function (k) { return !props.getProperty(k); });
  // Slack: o token e o caminho completo (posta e le reacao). O webhook so posta.
  if (!props.getProperty('SLACK_BOT_TOKEN')) {
    faltando.push(props.getProperty('SLACK_WEBHOOK')
      ? 'SLACK_BOT_TOKEN (esta so com webhook - posta, mas nao le reacao)'
      : 'SLACK_BOT_TOKEN ou SLACK_WEBHOOK');
  }

  const msg = 'Instalação concluída.\n' +
    'Gatilho: rodarMonitor a cada 1 hora.\n' +
    (faltando.length ? '⚠️ Faltam credenciais: ' + faltando.join(', ') : 'Credenciais OK.');
  Logger.log(msg);
  return msg;
}

/** Teste seco: verifica UMA fonte e escreve no log, sem chamar IA nem Slack. */
function testarUmaFonte(idFonte) {
  const fonte = carregarFontes_().filter(function (f) {
    return f['ID Fonte'] === (idFonte || 'F01'); })[0];
  if (!fonte) throw new Error('Fonte não encontrada: ' + idFonte);
  const r = verificarFonte_(fonte, lerEstado_());
  Logger.log(JSON.stringify({
    fonte: fonte['Entidade'], http: r.http, erro: r.erro,
    documentos: (r.documentos || []).map(function (d) { return d.url; }),
    observacao: r.observacao
  }, null, 2));
}

/**
 * SPIKE do Sprint 1: confirma se os sites respondem ao Apps Script.
 * Roda em ~1 minuto e diz exatamente quais fontes precisam de plano B.
 */
function testarTodasAsFontes() {
  const fontes = carregarFontes_();
  const falhas = [];
  fontes.forEach(function (f) {
    const r = buscar_(String(f['URL monitorada']), false);
    if (!r.ok) falhas.push(f['ID Fonte'] + ' ' + f['Entidade'] + ' → ' + r.http);
  });
  const msg = fontes.length + ' fontes testadas, ' + falhas.length + ' falharam:\n' + falhas.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * TESTE RETROATIVO (critério de aceite do Sprint 1).
 * Zera o estado e roda: o monitor deve encontrar as CCTs de 2026 que já existem,
 * incluindo a do Sindisaúde. Falso negativo em entidade P1 reprova a entrega.
 */
function testeRetroativo() {
  const ss = abrir_();
  const ws = ss.getSheetByName(CFG.ABAS.ESTADO);
  if (ws && ws.getLastRow() > 2) ws.deleteRows(3, ws.getLastRow() - 2);
  PropertiesService.getScriptProperties().setProperty('CURSOR', '0');
  Logger.log('Estado limpo. Rode rodarMonitor() repetidamente até o cursor voltar a 0 ' +
             'e confira a aba 04_CCTS contra a coluna "Aditivo / CCT 2026" da base.');
}

/** Reinício de emergência: qualquer pessoa autorizada roda isto. */
function reiniciar() {
  PropertiesService.getScriptProperties().setProperty('CURSOR', '0');
  instalar();
  return 'Monitor reiniciado em ' + agora_();
}

/** Situação atual, para quem chega no projeto sem contexto. */
function status() {
  const p = PropertiesService.getScriptProperties();
  const fontes = carregarFontes_();
  const s = {
    ultimaExecucao: p.getProperty('ULTIMA_EXECUCAO') || 'nunca',
    cursor: p.getProperty('CURSOR') || '0',
    totalFontes: fontes.length,
    mteAutomatico: CFG.MTE_AUTOMATICO,
    gatilhos: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); })
  };
  Logger.log(JSON.stringify(s, null, 2));
  return s;
}
