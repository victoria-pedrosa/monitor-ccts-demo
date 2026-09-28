/**
 * 20_Coletor.gs  |  Camada 1: acessa a fonte, encontra documentos e detecta mudança.
 *
 * Nenhuma IA é chamada aqui. Esta camada roda várias vezes por dia e precisa ser barata.
 * Todas as regras abaixo vieram de casos reais encontrados na varredura de 13/08/2026.
 */

const EXTENSOES_DOC = /\.(pdf|doc|docx)(\?|$)/i;
// v8: link com #toolbar=0 no fim (Comerciarios Salvador) tambem e documento.
const EXTENSOES_DOC_V8 = /\.(pdf|doc|docx)(\?|#|$)/i;
var ROTULOS_ = {};        // url do documento -> texto do link que apontava para ele
var LEITURA_V8_ = null;   // leitura ampliada liga/desliga pela propriedade LEITURA_V8
function leituraV8_() {
  if (LEITURA_V8_ === null) {
    LEITURA_V8_ = PropertiesService.getScriptProperties().getProperty('LEITURA_V8') === 'on';
  }
  return LEITURA_V8_;
}

/** Busca uma página com tolerância a falha. Não lança exceção. */
function buscar_(url, comoBinario) {
  try {
    const r = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,   // SINDECOND tem cadeia TLS quebrada
      headers: { 'Accept': '*/*', 'Accept-Language': 'pt-BR,pt;q=0.9' }
    });
    return {
      ok: r.getResponseCode() === 200,
      http: r.getResponseCode(),
      tipo: String(r.getHeaders()['Content-Type'] || r.getHeaders()['content-type'] || ''),
      texto: comoBinario ? null : r.getContentText(),
      blob: comoBinario ? r.getBlob() : null,
      bytes: comoBinario ? r.getBlob().getBytes().length : (r.getContentText() || '').length
    };
  } catch (e) {
    return { ok: false, http: 'ERRO', erro: String(e), tipo: '', bytes: 0 };
  }
}

/**
 * REGRA: rejeitar resposta cujo host final saia do domínio esperado.
 * Caso real: seeb.org.br/convencoes/ responde 200 mas redireciona para site de spam.
 */
function hostPermitido_(urlOrigem, urlDestino) {
  const h = function (u) { return String(u).split('/')[2] || ''; };
  const raiz = function (d) { return d.replace(/^www\./, '').split('.').slice(-3).join('.'); };
  return raiz(h(urlDestino)) === raiz(h(urlOrigem)) ||
         h(urlDestino).indexOf('diretasistemas.com.br') > -1 ||  // hospeda PDFs de SINDSEBA e comerciários
         h(urlDestino).indexOf('sintracom.org.br') > -1 ||
         h(urlDestino).indexOf('izap.com.br') > -1;
}

/** Extrai links de documento de uma página HTML e resolve caminhos relativos. */
function extrairDocumentos_(html, urlBase) {
  if (!html) return [];
  const encontrados = {};
  // Site montado por JavaScript (caso real: SHRBS, set/2026): os PDFs ficam dentro do .js,
  // fora de href. So quando a URL monitorada e um .js aceita qualquer texto entre aspas
  // terminado em .pdf/.doc. Nas paginas HTML nada muda.
  const re = /\.js(\?|$)/i.test(urlBase)
    ? /["'`]([^"'`\s<>]+\.(?:pdf|docx?))["'`]/gi
    : /href\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1];
    if (!EXTENSOES_DOC.test(href)) continue;
    if (href.indexOf('//') === 0) href = 'https:' + href;
    else if (href.indexOf('http') !== 0) {
      const base = urlBase.replace(/\/[^\/]*$/, '/');
      href = (href.charAt(0) === '/')
        ? urlBase.split('/').slice(0, 3).join('/') + href
        : base + href;
    }
    encontrados[href] = true;
  }
  // v8 (25/09/2026): a auditoria achou CCT 2026 que o robo nao via por causa do formato
  // do link. Casos reais: "#toolbar=0" no fim (F21), href sem aspas (F22), botao
  // "Download" sem .pdf (F29), Phoca "?download=123" (F30). Link sem extensao entra como
  // candidato; o content-type e conferido depois e descarta o que nao for arquivo.
  if (leituraV8_() && !/\.js(\?|$)/i.test(urlBase)) {
    linksPagina_(html, urlBase).forEach(function (l) {
      const ehDoc = EXTENSOES_DOC_V8.test(l.url);
      const ehDownload = /[?&]download=|\/download\b/i.test(l.url) ||
                         /^(download|baixar)$/i.test(l.texto) || /\.(pdf|docx?)\s*$/i.test(l.texto);
      if (!ehDoc && !ehDownload) return;
      encontrados[l.url] = true;
      if (l.texto && !ROTULOS_[l.url]) ROTULOS_[l.url] = l.texto.slice(0, 200);
    });
  }

  // Google Drive: SEEB entrega link de visualização, que devolve HTML em vez do arquivo
  const reDrive = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/g;
  while ((m = reDrive.exec(html)) !== null) {
    encontrados['https://drive.google.com/uc?export=download&id=' + m[1]] = true;
  }
  return Object.keys(encontrados);
}

/**
 * Verifica uma fonte. Devolve a lista de documentos NOVOS ou ALTERADOS.
 * A chave de detecção é composta: URL + nome + tamanho + hash do binário.
 */
function verificarFonte_(fonte, estado) {
  const url = String(fonte['URL monitorada']);
  const resposta = buscar_(url, false);

  if (!resposta.ok) {
    return { erro: true, http: resposta.http, documentos: [],
             observacao: 'Fonte não respondeu: ' + (resposta.erro || resposta.http) };
  }

  // REGRA: soft-404. SINDUSCON-BA e SINTRACOM devolvem 404 com o site inteiro no corpo.
  // Por isso nunca confiamos só no código HTTP: conferimos conteúdo e tamanho.
  if (resposta.bytes < 500) {
    return { erro: true, http: resposta.http, documentos: [], observacao: 'Resposta vazia ou truncada' };
  }

  const hashPagina = hash_(resposta.texto);
  var candidatos = extrairDocumentos_(resposta.texto, url);
  if (leituraV8_()) {
    candidatos = candidatos.concat(documentosDeSubpaginas_(resposta.texto, url))
      .filter(function (u, i, a) { return a.indexOf(u) === i; });
  }
  const novos = [];

  // REGRA: página existe e está vazia é um estado próprio, não erro.
  // Caso real: SINTRAPAN publicou /convencoes/ sem nenhum documento.
  if (candidatos.length === 0) {
    const chavePagina = fonte['ID Fonte'] + '|PAGINA';
    const anterior = estado[chavePagina];
    const mudou = !anterior || anterior['Hash'] !== hashPagina;
    return { erro: false, http: 200, documentos: [], hashPagina: hashPagina,
             paginaMudou: mudou, semDocumentos: true,
             observacao: mudou ? 'Página mudou, mas nenhum documento encontrado' : 'Sem alteração' };
  }

  for (var i = 0; i < candidatos.length; i++) {
    const urlDoc = candidatos[i];
    const chave = fonte['ID Fonte'] + '|' + urlDoc;
    const anterior = estado[chave];

    const doc = buscar_(urlDoc, true);
    if (!doc.ok) continue;

    // REGRA: allowlist de host. Impede coletar de domínio sequestrado ou de outra UF.
    if (!hostPermitido_(url, urlDoc)) {
      registrarMonitoramento_({ idFonte: fonte['ID Fonte'], entidade: fonte['Entidade'], url: urlDoc,
        http: doc.http, status: '🔴 BLOQUEADO - host fora do domínio esperado' });
      continue;
    }

    // REGRA: validar content-type, não só o HTTP 200.
    if (doc.tipo.indexOf('pdf') === -1 && doc.tipo.indexOf('officedocument') === -1 &&
        doc.tipo.indexOf('msword') === -1) continue;

    const mb = doc.bytes / 1048576;
    if (mb > CFG.TAMANHO_MAXIMO_PDF_MB) continue;

    const hashDoc = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, doc.blob.getBytes()));

    // REGRA: alguns sindicatos substituem o PDF mantendo o nome (SINDHOSBA, SINDHOSPES).
    // Por isso a comparação decisiva é o hash do conteúdo, não a URL.
    var tipoAlteracao = null;
    if (!anterior) tipoAlteracao = 'Documento novo';
    else if (anterior['Hash'] !== hashDoc) tipoAlteracao = 'Conteúdo alterado (mesmo endereço)';

    if (tipoAlteracao) {
      novos.push({ url: urlDoc, hash: hashDoc, bytes: doc.bytes, blob: doc.blob,
                   tipoAlteracao: tipoAlteracao, chave: chave, http: doc.http });
    } else {
      gravarEstado_(chave, { urlDocumento: urlDoc, hash: hashDoc, bytes: doc.bytes, httpStatus: doc.http });
    }
  }

  return { erro: false, http: 200, documentos: novos, hashPagina: hashPagina };
}

function hash_(texto) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto || ''));
}

/** Salva o documento original no Drive compartilhado. O PDF é a prova. */
function salvarNoDrive_(blob, entidade, urlDoc) {
  const pasta = DriveApp.getFolderById(CFG.PASTA_DRIVE_ID);
  const nomeOriginal = urlDoc.split('/').pop().split('?')[0] || 'documento.pdf';
  const nome = Utilities.formatDate(new Date(), CFG.FUSO, 'yyyy-MM-dd') + '_' +
               String(entidade).replace(/[^\w\-]/g, '') + '_' + nomeOriginal;
  const arquivo = pasta.createFile(blob.setName(nome));
  return arquivo.getUrl();
}

/**
 * v8 - REGRA: CCT nova as vezes fica uma pagina abaixo (FECOMERCIO /2026-2027/, SINPOSBA
 * dentro de noticia, SEAC em subpasta). Segue ate 6 links do mesmo site cujo texto ou
 * endereco fala de convencao/aditivo E de um ano recente. Se a subpagina nao tiver
 * documento, olha ate 3 subpastas irmas dela (sem ano antigo no nome).
 */
function documentosDeSubpaginas_(html, urlBase) {
  if (!html || /\.js(\?|$)/i.test(urlBase)) return [];
  const y = new Date().getFullYear();
  const reAno = new RegExp('(' + (y - 1) + '|' + y + '|' + (y + 1) + ')');
  const reVelho = /(19|20)\d\d/;
  const reTema = /conven|cct|aditiv|acordo|diss[ií]dio|piso|reajuste/i;
  const vistos = {};
  const subs = linksPagina_(html, urlBase).filter(function (l) {
    const alvo = l.texto + ' ' + l.url;
    if (vistos[l.url] || l.url === urlBase || EXTENSOES_DOC_V8.test(l.url)) return false;
    if (!reAno.test(alvo) || !reTema.test(alvo) || !hostPermitido_(urlBase, l.url)) return false;
    vistos[l.url] = true;
    return true;
  }).slice(0, 6);

  const achados = {};
  subs.forEach(function (s) {
    const r = buscar_(s.url, false);
    if (!r.ok || !r.texto || r.tipo.indexOf('html') < 0) return;
    var docs = extrairDocumentos_(r.texto, s.url);
    if (!docs.length) {
      const pasta = s.url.replace(/[?#].*$/, '').replace(/\/[^\/]*\/?$/, '/');
      linksPagina_(r.texto, s.url).filter(function (l) {
        const alvo = l.texto + ' ' + l.url;
        return l.url.indexOf(pasta) === 0 && l.url !== s.url && !EXTENSOES_DOC_V8.test(l.url) &&
               (!reVelho.test(alvo) || reAno.test(alvo));
      }).slice(0, 3).forEach(function (l2) {
        const r2 = buscar_(l2.url, false);
        if (r2.ok && r2.texto && r2.tipo.indexOf('html') > -1) {
          docs = docs.concat(extrairDocumentos_(r2.texto, l2.url));
        }
      });
    }
    docs.forEach(function (d) {
      achados[d] = true;
      if (!ROTULOS_[d]) ROTULOS_[d] = String(s.texto).slice(0, 200);
    });
  });
  return Object.keys(achados);
}

/** Todos os links <a> da pagina, com o texto visivel. Aceita href com ou sem aspas. */
function linksPagina_(html, urlBase) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*(?:["']([^"']+)["']|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    const h = m[1] || m[2];
    if (!h || /^(#|mailto:|tel:|javascript:)/i.test(h)) continue;
    out.push({ url: resolverUrl_(h.replace(/#.*$/, ''), urlBase),
               texto: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** Mesma regra de endereco relativo usada em extrairDocumentos_ (nao mudar: vira chave do estado). */
function resolverUrl_(href, urlBase) {
  if (href.indexOf('//') === 0) return 'https:' + href;
  if (href.indexOf('http') === 0) return href;
  const base = urlBase.replace(/\/[^\/]*$/, '/');
  return (href.charAt(0) === '/') ? urlBase.split('/').slice(0, 3).join('/') + href : base + href;
}
