/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Logger.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : écriture dans la feuille `Logs`.
 *
 * Toute valeur écrite est passée par redact() : aucun secret ne doit
 * apparaître dans les journaux (Phase 1, §6.2).
 */

/**
 * Écrit une entrée de journal.
 *
 * @param {{level:string, action:string, articleId?:string, slug?:string,
 *          status?:string, githubPath?:string, message?:string, details?:*}} e
 */
function logEvent(e) {
  try {
    var sheet = getSheetByNameOrCreate(SHEETS.LOGS, { create: false });
    if (!sheet) {
      // Aucun journal : on ne bloque jamais la publication pour un log.
      console.error('Feuille Logs introuvable : ' + redact(e.message || ''));
      return;
    }
    sheet.appendRow([
      nowIso(),
      level(e.level),
      redact(e.action || ''),
      redact(e.articleId || ''),
      redact(e.slug || ''),
      redact(e.status || ''),
      redact(e.githubPath || ''),
      redact(e.message || ''),
      detailsText(e.details)
    ]);
  } catch (err) {
    console.error('Échec journalisation : ' + redact(String(err && err.message)));
  }
}

function logInfo(action, message, details) {
  logEvent({ level: LEVEL.INFO, action: action, message: message, details: details });
}

function logSuccess(action, fields) {
  var f = fields || {};
  logEvent({
    level: LEVEL.SUCCESS,
    action: action,
    articleId: f.articleId,
    slug: f.slug,
    status: f.status,
    githubPath: f.githubPath,
    message: f.message,
    details: f.details
  });
}

function logWarning(action, message, details) {
  logEvent({ level: LEVEL.WARNING, action: action, message: message, details: details });
}

function logError(action, message, fields) {
  var f = fields || {};
  logEvent({
    level: LEVEL.ERROR,
    action: action,
    articleId: f.articleId,
    slug: f.slug,
    status: f.status,
    githubPath: f.githubPath,
    message: message,
    details: f.details
  });
}

/** Normalise un niveau vers la liste autorisée. */
function level(value) {
  var v = String(value || '').toUpperCase();
  if (v === LEVEL.INFO || v === LEVEL.SUCCESS || v === LEVEL.WARNING || v === LEVEL.ERROR) {
    return v;
  }
  return LEVEL.INFO;
}

/** Détails : objets → JSON compacte, chaînes → texte, le tout redacté. */
function detailsText(details) {
  if (details === null || details === undefined || details === '') return '';
  if (typeof details === 'string') return redact(details);
  return redact(toJson(details));
}

/**
 * Liste les entrées d'erreur, plus récentes d'abord.
 * @param {number=} limit
 * @return {Array<Object>}
 */
function readErrorLogs(limit) {
  var sheet = getSheetByNameOrCreate(SHEETS.LOGS, { create: false });
  if (!sheet || sheet.getLastRow() < 2) return [];
  var max = limit || 50;
  var first = Math.max(2, sheet.getLastRow() - max + 1);
  var values = sheet.getRange(first, 1, sheet.getLastRow() - first + 1, LOG_COLUMNS.length)
    .getValues();
  var out = [];
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][1]).toUpperCase() !== LEVEL.ERROR) continue;
    out.push({
      TIMESTAMP: values[i][0],
      LEVEL: values[i][1],
      ACTION: values[i][2],
      ARTICLE_ID: values[i][3],
      SLUG: values[i][4],
      STATUS: values[i][5],
      GITHUB_PATH: values[i][6],
      MESSAGE: values[i][7],
      DETAILS: values[i][8]
    });
  }
  return out;
}
