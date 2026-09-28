/**
 * 10_Planilha.gs  |  Leitura e escrita nas abas. Nada mais toca na planilha diretamente.
 */

function abrir_() {
  return SpreadsheetApp.openById(CFG.PLANILHA_ID);
}

function aba_(nome) {
  const ws = abrir_().getSheetByName(nome);
  if (!ws) throw new Error('Aba não encontrada: ' + nome + '. Rode instalar() primeiro.');
  return ws;
}

/** Devolve as linhas de uma aba como objetos, usando o cabeçalho da linha 2. */
function lerAba_(nome) {
  const ws = aba_(nome);
  const ultima = ws.getLastRow();
  if (ultima <= CFG.LINHA_CABECALHO) return [];
  const cabecalho = ws.getRange(CFG.LINHA_CABECALHO, 1, 1, ws.getLastColumn()).getValues()[0];
  const dados = ws.getRange(CFG.LINHA_CABECALHO + 1, 1, ultima - CFG.LINHA_CABECALHO, ws.getLastColumn()).getValues();
  return dados.map(function (linha, i) {
    const o = { _linha: CFG.LINHA_CABECALHO + 1 + i };
    cabecalho.forEach(function (c, j) { if (c) o[String(c).trim()] = linha[j]; });
    return o;
  });
}

/** Fontes ativas, já ordenadas por prioridade das entidades que elas atendem. */
function carregarFontes_() {
  const fontes = lerAba_(CFG.ABAS.FONTES).filter(function (f) {
    return f['URL monitorada'] && String(f['URL monitorada']).indexOf('http') === 0;
  });
  const sindicatos = lerAba_(CFG.ABAS.SINDICATOS);

  // prioridade da fonte = maior prioridade entre as entidades que dependem dela
  const peso = { P1: 3, P2: 2, P3: 1 };
  const prioridadePorFonte = {};
  sindicatos.forEach(function (s) {
    [s['Fonte primária'], s['Fonte secundária']].forEach(function (fid) {
      if (!fid) return;
      const p = peso[s['Prioridade']] || 1;
      if (!prioridadePorFonte[fid] || prioridadePorFonte[fid] < p) prioridadePorFonte[fid] = p;
    });
  });

  fontes.forEach(function (f) { f._peso = prioridadePorFonte[f['ID Fonte']] || 1; });
  fontes.sort(function (a, b) { return b._peso - a._peso; });
  return fontes;
}

/** Entidades que dependem de uma fonte. Usado para montar o contexto da IA. */
function entidadesDaFonte_(idFonte) {
  return lerAba_(CFG.ABAS.SINDICATOS).filter(function (s) {
    return s['Fonte primária'] === idFonte || s['Fonte secundária'] === idFonte;
  });
}

// ---------------------------------------------------------------- ESTADO

/** Estado = último hash conhecido por documento. É o que diferencia "novo" de "já visto". */
function lerEstado_() {
  const linhas = lerAba_(CFG.ABAS.ESTADO);
  const mapa = {};
  linhas.forEach(function (l) { mapa[l['Chave']] = l; });
  return mapa;
}

function gravarEstado_(chave, dados) {
  const ws = aba_(CFG.ABAS.ESTADO);
  const existentes = lerEstado_();
  const linha = [chave, dados.urlDocumento, dados.hash, dados.bytes,
                 agora_(), dados.httpStatus, dados.observacao || ''];
  if (existentes[chave]) {
    ws.getRange(existentes[chave]._linha, 1, 1, linha.length).setValues([linha]);
  } else {
    ws.appendRow(linha);
  }
}

// ---------------------------------------------------------------- LOGS

function registrarMonitoramento_(reg) {
  aba_(CFG.ABAS.MONITORAMENTO).appendRow([
    novoId_('EXEC'), agora_(), reg.idFonte, reg.entidade, reg.url, reg.http,
    reg.hash || '', reg.alterou ? 'SIM' : 'NÃO', reg.tipoAlteracao || '-',
    reg.urlDocumento || '-', reg.parecerGemini || '-', reg.confianca || '',
    reg.parecerClaude || '-', reg.status, reg.idCct || '-'
  ]);
}

function registrarCct_(c) {
  const id = novoId_('CCT');
  aba_(CFG.ABAS.CCTS).appendRow([
    id, c.sindicato_laboral, c.sindicato_patronal, c.tipo,
    c.vigencia_inicio, c.vigencia_fim, c.data_base, c.reajuste_percentual, c.piso_salarial,
    Utilities.formatDate(new Date(), CFG.FUSO, 'dd/MM/yyyy'),
    c.urlDocumento, c.linkDrive, c.numero_registro_mte || '',
    c.statusMte || '🟡 Aguardando conferência no MTE',
    c.confianca, '', ''
  ]);
  return id;
}

function registrarFila_(f) {
  const id = novoId_('ALT');
  aba_(CFG.ABAS.FILA).appendRow([
    id, agora_(), f.entidade, f.documento, f.parecerGemini, f.parecerClaude,
    f.divergencia ? 'SIM' : 'NAO', '', '', '', '', ''   // ...+ L = Slack TS
  ]);
  return id;
}

/** Grava a decisão vinda do botão do Slack. */
function decidirFila_(idAlerta, decisao, responsavel) {
  const ws = aba_(CFG.ABAS.FILA);
  const linhas = lerAba_(CFG.ABAS.FILA);
  for (var i = 0; i < linhas.length; i++) {
    if (linhas[i]['ID Alerta'] === idAlerta) {
      ws.getRange(linhas[i]._linha, 8).setValue(decisao);       // H - Decisão humana
      ws.getRange(linhas[i]._linha, 10).setValue(responsavel);  // J - Responsável
      ws.getRange(linhas[i]._linha, 11).setValue(Utilities.formatDate(new Date(), CFG.FUSO, 'dd/MM/yyyy HH:mm'));
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- utilitários

function agora_() {
  return Utilities.formatDate(new Date(), CFG.FUSO, 'dd/MM/yyyy HH:mm');
}

function novoId_(prefixo) {
  const p = PropertiesService.getScriptProperties();
  const chave = 'SEQ_' + prefixo;
  const n = Number(p.getProperty(chave) || 0) + 1;
  p.setProperty(chave, String(n));
  return prefixo + Utilities.formatString('%04d', n);
}


// ---------------------------------------------------------------- empresas impactadas
// Aba 10_EMPRESAS = carteira ativa. Aba 12_DEPARA = rotulo da carteira -> ID do sindicato.

var _empresasCache = null, _deParaCache = null;

/** Normaliza rotulo: sem acento, sem pontuacao, maiusculo. 'M.T.E', 'MTE' e 'M.T.E.' viram a mesma chave. */
function chaveRotulo_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                        .toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function carregarDePara_() {
  if (_deParaCache) return _deParaCache;
  const mapa = {};
  lerAba_(CFG.ABAS.DEPARA).forEach(function (l) {
    const rotulo = l['Rotulo na base de empresas'];
    if (!rotulo) return;
    mapa[chaveRotulo_(rotulo)] = {
      ids: String(l['ID(s) sindicato'] || '').split(';')
             .map(function (s) { return s.trim(); }).filter(String),
      notificar: String(l['Notificar?'] || '').trim().toUpperCase()
    };
  });
  _deParaCache = mapa;
  return mapa;
}

function carregarEmpresas_() {
  if (_empresasCache) return _empresasCache;
  _empresasCache = lerAba_(CFG.ABAS.EMPRESAS).filter(function (e) { return e['Empresa']; });
  return _empresasCache;
}

/**
 * Empresas impactadas por UM sindicato (ID do 01_SINDICATOS).
 * REGRA DE OURO: rotulo que nao esta marcado SIM no de-para nao entra na lista automatica,
 * vai para pendentes. Notificar a empresa errada e pior do que notificar de menos.
 */
function empresasDoSindicato_(idSindicato) {
  const mapa = carregarDePara_();
  const r = { notificar: [], pendentes: [] };
  carregarEmpresas_().forEach(function (e) {
    const d = mapa[chaveRotulo_(e['Sindicato Laboral'])];
    if (!d || d.ids.indexOf(idSindicato) === -1) return;
    const reg = {
      empresa:  String(e['Empresa'] || '').trim(),
      cnpj:     String(e['CNPJ'] || '').trim(),
      rotulo:   String(e['Sindicato Laboral'] || '').trim(),
      patronal: String(e['Sindicato Patronal'] || '').trim(),
      folha:    String(e['Folha Responsavel'] || e['Folha Responsável'] || '').trim(),
      municipio: String(e['Municipio'] || e['Município'] || '').trim(),
      uf:        String(e['UF'] || '').trim()
    };
    if (d.notificar === 'SIM') r.notificar.push(reg); else r.pendentes.push(reg);
  });
  return r;
}

/** Uma fonte pode servir varias entidades. Une as listas sem repetir CNPJ. */
function empresasImpactadas_(entidades) {
  const vistos = {}, r = { notificar: [], pendentes: [] };
  entidades.forEach(function (ent) {
    const res = empresasDoSindicato_(ent['ID']);
    ['notificar', 'pendentes'].forEach(function (k) {
      res[k].forEach(function (e) {
        const chave = e.cnpj + '|' + e.empresa;
        if (vistos[chave]) return;
        vistos[chave] = true;
        r[k].push(e);
      });
    });
  });
  return r;
}

/** 'São Paulo/SP' e 'SAO PAULO' viram a mesma chave. Acento e UF nao podem separar cidade. */
function chaveMunicipio_(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s*\/\s*[A-Z]{2}\s*$/, '')
    .replace(/[^A-Z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Corta da lista de impactadas quem esta fora da base territorial da convencao.
 *
 * CCT so alcanca empresa sediada em municipio da base territorial dela. Sem este
 * filtro o alerta dizia "67 empresas impactadas" quando o numero real podia ser 3.
 *
 * Duas travas, as duas pela mesma razao (falso negativo e pior que falso positivo):
 *  - documento sem lista de municipios -> NAO filtra nada, so avisa que nao deu para conferir
 *  - empresa sem municipio cadastrado  -> CONTINUA na lista, marcada para conferencia manual
 */
function filtrarPorBaseTerritorial_(empresas, municipios) {
  const lista = (municipios || []).map(chaveMunicipio_).filter(String);
  const r = {
    notificar: empresas.notificar, pendentes: empresas.pendentes,
    fora: [], semMunicipio: [], aplicouFiltro: false, municipios: lista.length
  };
  if (!lista.length) return r;          // documento nao trouxe base territorial

  r.aplicouFiltro = true;
  const dentro = [];
  empresas.notificar.forEach(function (e) {
    const k = chaveMunicipio_(e.municipio);
    if (!k)                        { dentro.push(e); r.semMunicipio.push(e); }
    else if (lista.indexOf(k) > -1) dentro.push(e);
    else                            r.fora.push(e);
  });
  r.notificar = dentro;
  return r;
}

/** 'Colaborador 68 (12), Colaborador 90 (7), Colaborador 66 (4)' */
function porFolha_(lista) {
  const c = {};
  lista.forEach(function (e) {
    const k = (e.folha || 'sem responsavel').split(' - ')[0];
    c[k] = (c[k] || 0) + 1;
  });
  return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })
               .map(function (k) { return k + ' (' + c[k] + ')'; }).join(', ');
}

/** Planilha das empresas a notificar, salva na pasta do Drive. Devolve a URL. */
function planilhaEmpresas_(idCct, sigla, res) {
  const nome = 'EMPRESAS_A_NOTIFICAR_' + String(sigla).replace(/[^A-Za-z0-9-]/g, '_') + '_' + idCct;
  const ss = SpreadsheetApp.create(nome);
  const cab = ['Empresa', 'CNPJ', 'Rotulo na base', 'Sindicato patronal', 'Folha responsavel'];

  function preencher(ws, lista) {
    const linhas = [cab];
    lista.forEach(function (e) { linhas.push([e.empresa, e.cnpj, e.rotulo, e.patronal, e.folha]); });
    ws.getRange(1, 1, linhas.length, cab.length).setValues(linhas);
    ws.getRange(1, 1, 1, cab.length).setFontWeight('bold');
    ws.setFrozenRows(1);
  }

  const ws = ss.getSheets()[0];
  ws.setName('A NOTIFICAR');
  preencher(ws, res.notificar);
  if (res.pendentes.length) preencher(ss.insertSheet('CONFERIR DE-PARA'), res.pendentes);

  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(CFG.PASTA_DRIVE_ID));
  return ss.getUrl();
}


/** Guarda o ts da mensagem do Slack (coluna L). E a chave que liga a linha da fila a mensagem. */
function gravarSlackTs_(idAlerta, ts) {
  const ws = aba_(CFG.ABAS.FILA);
  const linhas = lerAba_(CFG.ABAS.FILA);
  for (var i = 0; i < linhas.length; i++) {
    if (linhas[i]['ID Alerta'] === idAlerta) {
      // O ts do Slack tem 16 digitos significativos. Em celula numerica o Sheets
      // arredonda para 15 e a mensagem deixa de ser encontrada. Tem que ser texto.
      const cel = ws.getRange(linhas[i]._linha, 12);
      cel.setNumberFormat('@');
      cel.setValue(String(ts));
      return true;
    }
  }
  return false;
}

/** Alertas que ja foram para o Slack e ainda nao tem decisao humana. */
function filaPendente_() {
  return lerAba_(CFG.ABAS.FILA).filter(function (l) {
    return l['Slack TS'] && !String(l['Decisao humana'] || l['Decisão humana'] || '').trim();
  });
}
