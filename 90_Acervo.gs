/**
 * Liga a adocao em modo automatico: um gatilho a cada 5 minutos.
 *
 * Cada bloco processa o que da em 4min30 - a primeira fonte sozinha tinha 80
 * documentos. Clicar em Executar dezenas de vezes nao e trabalho de gente.
 * O gatilho se apaga sozinho quando o acervo termina.
 */
function ligarAdocaoAutomatica() {
  const jaTem = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'adotarAcervo';
  });
  if (!jaTem) ScriptApp.newTrigger('adotarAcervo').timeBased().everyMinutes(5).create();
  const msg = 'Adocao automatica ligada: roda de 5 em 5 minutos e se desliga sozinha ao terminar. ' +
              'Acompanhe em Execucoes ou rode comoEstaAdocao().';
  Logger.log(msg);
  return msg;
}


/**
 * 90_Acervo.gs  |  Marco zero: adotar o que ja esta nos sites.
 *
 * O coletor detecta ARQUIVO NOVO NO SITE. Na primeira passada TUDO e novo, entao o
 * acervo inteiro do sindicato virou alerta - CCT de 2024, aditivo de 2025, tudo.
 *
 * Filtrar por vigencia nao resolve e ainda cria risco: convencao publicada hoje
 * costuma ter vigencia retroativa (assinada em agosto, valendo desde janeiro).
 * O criterio certo nao e a data do documento, e QUANDO ELE APARECEU NO SITE.
 *
 * Esta funcao percorre as fontes, anota a impressao digital de cada documento que
 * ja esta la e nao alerta nada. A partir daqui, so vira alerta arquivo que surgir
 * DEPOIS. Nao chama IA, nao posta no Slack, nao gasta cota.
 *
 * Roda em blocos por causa do limite de tempo do Apps Script: clique em Executar
 * quantas vezes precisar, ela retoma de onde parou e avisa quando chegar ao fim.
 */
function adotarAcervo() {
  const inicio = new Date().getTime();
  // Uma rodada por vez: fonte grande passa de 5 min e o gatilho seguinte atropelava.
  const trava = LockService.getScriptLock();
  if (!trava.tryLock(1000)) { Logger.log('Adocao anterior ainda rodando - esta rodada pulou.'); return 'pulou'; }
  const props = PropertiesService.getScriptProperties();
  const fontes = carregarFontes_();
  const estado = lerEstado_();

  var cursor = Number(props.getProperty('CURSOR_ACERVO') || 0);
  var docs = 0, fontesLidas = 0;
  const falhas = [];
  var reservados = 0;
  // v8: com ACERVO_FONTES preenchida, so passa pelas fontes da lista (as que ganharam links novos).
  const soFontes = (props.getProperty('ACERVO_FONTES') || '').split(',').filter(String);

  while (cursor < fontes.length) {
    if (new Date().getTime() - inicio > CFG.TEMPO_MAXIMO_MS) break;

    const fonte = fontes[cursor];
    cursor++;
    if (soFontes.length && soFontes.indexOf(fonte['ID Fonte']) < 0) continue;
    fontesLidas++;

    try {
      const r = verificarFonte_(fonte, estado);

      if (r.hashPagina) {
        gravarEstado_(fonte['ID Fonte'] + '|PAGINA', {
          urlDocumento: fonte['URL monitorada'], hash: r.hashPagina, bytes: 0, httpStatus: 200,
          observacao: 'Marco zero - pagina adotada sem alertar'
        });
      }

      (r.documentos || []).forEach(function (doc) {
        // Modo "links novos" (v8): o robo passou a enxergar links que antes nao via.
        // Documento de 2026/2027 nunca foi conferido por ninguem: fica de fora e vira alerta.
        if (props.getProperty('ACERVO_MODO') === 'links-novos' &&
            /(2026|2027)/.test(doc.url + ' ' + (ROTULOS_[doc.url] || ''))) { reservados++; return; }
        gravarEstado_(doc.chave, {
          urlDocumento: doc.url, hash: doc.hash, bytes: doc.bytes, httpStatus: doc.http,
          observacao: 'Marco zero - documento ja existia, adotado sem alertar'
        });
        docs++;
      });

    } catch (e) {
      falhas.push(fonte['ID Fonte'] + ': ' + e.message);
    }
  }

  const fim = cursor >= fontes.length;
  if (fim) { props.deleteProperty('CURSOR_ACERVO'); props.deleteProperty('ACERVO_MODO'); props.deleteProperty('ACERVO_FONTES'); desligarAdocaoAutomatica_(); }
  else props.setProperty('CURSOR_ACERVO', String(cursor));

  const msg = (fim ? 'ACERVO ADOTADO. ' : 'PARCIAL - clique em Executar de novo. ') +
              'Fontes nesta rodada: ' + fontesLidas + ' (posicao ' + cursor + ' de ' + fontes.length + '). ' +
              'Documentos anotados: ' + docs + '. Reservados para alerta (2026/2027): ' + reservados + '.' +
              (falhas.length ? '\nFontes com falha (' + falhas.length + '): ' + falhas.join(' | ') : '') +
              (fim ? '\nA partir de agora so vira alerta arquivo que aparecer nos sites DEPOIS deste momento.' : '');
  Logger.log(msg);
  return msg;
}

/** Quanto falta para terminar a adocao do acervo. */
function comoEstaAdocao() {
  const props = PropertiesService.getScriptProperties();
  const cursor = Number(props.getProperty('CURSOR_ACERVO') || 0);
  const total = carregarFontes_().length;
  const msg = cursor === 0
    ? 'Nenhuma adocao em andamento. Se ja rodou ate o fim, o acervo esta adotado.'
    : 'Adocao em andamento: ' + cursor + ' de ' + total + ' fontes. Rode adotarAcervo() de novo.';
  Logger.log(msg);
  return msg;
}

/** Remove o gatilho da adocao. Chamado sozinho quando o acervo termina. */
function desligarAdocaoAutomatica_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'adotarAcervo') ScriptApp.deleteTrigger(t);
  });
}
