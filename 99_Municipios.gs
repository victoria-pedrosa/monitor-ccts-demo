/**
 * 99_Municipios.gs  |  TEMPORARIO. Rodar uma vez e apagar o arquivo.
 *
 * ligarLeituraV8: liga a leitura ampliada do coletor (links com #, sem aspas, botao
 * Download, subpaginas) e dispara a adocao do acervo no modo "links novos":
 * - documento antigo que o robo passa a enxergar e anotado sem alerta;
 * - documento com 2026/2027 no endereco ou no texto do link fica de fora e vira alerta.
 * O gatilho de adocao pausa o rodarMonitor ate terminar e depois se apaga sozinho.
 * Para desfazer: apagar a propriedade LEITURA_V8.
 */
function ligarLeituraV8() {
  const props = PropertiesService.getScriptProperties();
  const msg = ligarAdocaoAutomatica();          // primeiro o gatilho: ele pausa o monitor
  props.deleteProperty('CURSOR_ACERVO');
  props.setProperties({ ACERVO_MODO: 'links-novos', LEITURA_V8: 'on' });
  Logger.log('Leitura v8 ligada. ' + msg);
  return msg;
}

/** Restringe a adocao v8 as fontes que ganharam links novos (auditoria de 25/09) e recomeca do inicio. */
function restringirAdocaoV8() {
  const lista = 'F13,F16,F21,F22,F23,F24,F29,F30,F37,F42,F45,F50,F52,F59,F65';
  PropertiesService.getScriptProperties().setProperties({ ACERVO_FONTES: lista, CURSOR_ACERVO: '0' });
  Logger.log('Adocao v8 restrita a: ' + lista);
  return lista;
}
