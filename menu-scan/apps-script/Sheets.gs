/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Sheets.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : structure et accès aux feuilles `Articles`, `Config`
 * et `Logs`. Création idempotente, lecture pilotée par les en-têtes (l'ordre
 * des colonnes n'est pas critique), écriture ciblée.
 *
 * Décision D1 : quatre champs de description distincts
 *   META_DESCRIPTION (déjà dans les colonnes imposées)
 * + SOCIAL_DESCRIPTION, ARTICLE_EXCERPT, CARD_EXCERPT (ajoutés, documentés §5.3).
 * Décision D8 : aucun fichier de test n'est créé ni modifié par ce module.
 *
 * Phase 2 : une page = une LANGUE. `LANG` et `TRANSLATION_GROUP` sont
 * dorénavant structurels — ils entrent dans le chemin
 * (/blog/{lang}/{slug}.html) et dans les hreflang.
 */

/** Noms de feuilles — exactement 3 feuilles principales. */
var SHEETS = {
  ARTICLES: 'Articles',
  CONFIG: 'Config',
  LOGS: 'Logs'
};

/**
 * Colonnes `Articles`.
 *
 * Les 14 colonnes imposées par la mission sont conservées dans leur ordre,
 * SAUF `WP_POST_ID` et `WP_URL` : le blog est publié par Git, il n'y a plus de
 * WordPress derrière (aucun ID, aucune URL à réconcilier). Les ajouts sont
 * groupés par usage.
 *
 * `READING_TIME` est une donnée éditoriale saisie : le moteur de rendu l'exige
 * et ne la calcule JAMAIS (jamais dérivée du nombre de mots).
 */
var ARTICLE_COLUMNS = [
  // --- Colonnes imposées (ordre inchangé, WP_* retirés) ---
  'ID',
  'TITLE',
  'KEYWORD',
  'CONTENT',
  'CATEGORY',
  'SLUG',
  'SEO_TITLE',
  'META_DESCRIPTION',
  'IMAGE_URL',
  'STATUS',
  'PUBLISHED_AT',
  'ERROR',
  // --- Phase 2 : identité de la page ---
  // LANG entre dans le chemin du fichier ET dans les hreflang : il structure
  // la publication, il n'est pas décoratif.
  'LANG',
  // TRANSLATION_GROUP relie les lignes d'un même contenu. Le moteur refuse
  // deux lignes de même langue pour un groupe (une seule URL par langue).
  'TRANSLATION_GROUP',
  // --- Phase 2 : données de l'image ---
  // IMAGE_ALT est obligatoire (accessibilité + SEO) ; les dimensions sont des
  // entiers positifs, pour éviter le décalage de mise en page (CLS).
  'IMAGE_ALT',
  'IMAGE_WIDTH',
  'IMAGE_HEIGHT',
  'IMAGE_CREDIT',
  // --- Ajout D1 : descriptions distinctes ---
  'SOCIAL_DESCRIPTION',
  'ARTICLE_EXCERPT',
  'CARD_EXCERPT',
  // --- Ajout D1 (intégration Renderer) : temps de lecture, saisi ---
  'READING_TIME',
  // --- Ajout technique : idempotence / traçabilité ---
  'GITHUB_PATH',
  'GITHUB_SHA',
  'GITHUB_COMMIT'
];

/** Colonnes `Logs`. */
var LOG_COLUMNS = [
  'TIMESTAMP',
  'LEVEL',
  'ACTION',
  'ARTICLE_ID',
  'SLUG',
  'STATUS',
  'GITHUB_PATH',
  'MESSAGE',
  'DETAILS'
];

/** Statuts autorisés. */
var STATUS = {
  DRAFT: 'DRAFT',
  READY: 'READY',
  PUBLISHING: 'PUBLISHING',
  PUBLISHED: 'PUBLISHED',
  ERROR: 'ERROR'
};

var VALID_STATUSES = [
  STATUS.DRAFT, STATUS.READY, STATUS.PUBLISHING, STATUS.PUBLISHED, STATUS.ERROR
];

/** Niveaux de log. */
var LEVEL = {
  INFO: 'INFO',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  ERROR: 'ERROR'
};

/* -------------------------------------------------------------------------- */
/* Accès                                                                      */
/* -------------------------------------------------------------------------- */

function getSpreadsheet() {
  var id = propGet(PROP_KEYS.SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error(
      'Spreadsheet introuvable. Renseigner SPREADSHEET_ID en Script Property ' +
      'ou lier le script au tableur.'
    );
  }
  return active;
}

/**
 * Retourne la feuille par nom, ou la crée si absente.
 * @param {string} name
 * @param {Object=} opts {create:boolean}
 */
function getSheetByNameOrCreate(name, opts) {
  var create = !opts || opts.create !== false;
  var sheet = getSpreadsheet().getSheetByName(name);
  if (!sheet && create) sheet = getSpreadsheet().insertSheet(name);
  return sheet;
}

/** Lecture seule : retourne la feuille ou null si elle n'existe pas encore. */
function getSheetByName(name) {
  return getSheetByNameOrCreate(name, { create: false });
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Crée les feuilles manquantes et écrit les en-têtes attendus.
 * N'écrase AUCUNE donnée existante : si un en-tête diffère, l'écart est
 * rapporté (drift) au lieu d'être corrigé silencieusement.
 *
 * Les menus déroulants sont (ré)appliqués à chaque appel, y compris sur une
 * feuille existante : ils font partie de l'initialisation, pas d'un one-shot.
 *
 * @return {{created:string[], missingHeaders:Object[], dropdowns:Object}}
 */
function bootstrapSheets() {
  var report = { created: [], missingHeaders: [], dropdowns: { applied: [], failed: [] } };

  var articles = getSheetByNameOrCreate(SHEETS.ARTICLES);
  if (isNewSheet(articles)) {
    articles.getRange(1, 1, 1, ARTICLE_COLUMNS.length)
      .setValues([ARTICLE_COLUMNS]);
    report.created.push(SHEETS.ARTICLES);
  } else {
    report.missingHeaders.push.apply(
      report.missingHeaders,
      checkHeaders(articles, ARTICLE_COLUMNS, SHEETS.ARTICLES)
    );
  }
  report.dropdowns = applyArticleDropdowns(articles);

  var logs = getSheetByNameOrCreate(SHEETS.LOGS);
  if (isNewSheet(logs)) {
    logs.getRange(1, 1, 1, LOG_COLUMNS.length).setValues([LOG_COLUMNS]);
    report.created.push(SHEETS.LOGS);
  } else {
    report.missingHeaders.push.apply(
      report.missingHeaders,
      checkHeaders(logs, LOG_COLUMNS, SHEETS.LOGS)
    );
  }

  var configCreated = ensureConfigSheet();
  if (configCreated.length) report.created.push(SHEETS.CONFIG);

  return report;
}

function isNewSheet(sheet) {
  return sheet.getLastRow() < 1;
}

/**
 * Listes imposées pour les colonnes à valeurs fermées.
 *
 * Elles sont dérivées des sources uniques (Config.gs / ci-dessus), jamais
 * recopiées : `LANG` suit APP.SUPPORTED_LANGS, `CATEGORY` suit CATEGORY_SLUGS,
 * `STATUS` suit VALID_STATUSES.
 */
var ARTICLE_DROPDOWNS = {
  LANG: function () { return APP.SUPPORTED_LANGS; },
  CATEGORY: function () { return listKnownCategories(); },
  STATUS: function () { return VALID_STATUSES; }
};

/** Nombre de lignes de données couvertes par les règles (≥ 1). */
var DROPDOWN_MIN_ROWS = 500;

/**
 * Applique (ou réapplique) les menus déroulants de `Articles`.
 *
 * Idempotent et auto-réparateur : appelé à CHAQUE bootstrap, donc une colonne
 * ajoutée ou une liste qui change est prise en compte sans intervention.
 *
 * Une règle qui ne s'applique pas (feuille protégée, colonne absente, API de
 * validation indisponible) est signalée dans le rapport au lieu de faire
 * échouer le bootstrap : une garde de saisie ergonomique ne doit jamais
 * empêcher la lecture des articles.
 *
 * @return {{applied:string[], failed:Object[]}}
 */
function applyArticleDropdowns(sheet) {
  var report = { applied: [], failed: [] };
  if (!sheet) return report;

  var map = headerIndex(sheet);
  var rows = Math.max(sheet.getMaxRows ? sheet.getMaxRows() - 1 : 0, DROPDOWN_MIN_ROWS);

  Object.keys(ARTICLE_DROPDOWNS).forEach(function (column) {
    var col = map[column];
    if (!col) {
      report.failed.push({ column: column, reason: 'colonne absente' });
      return;
    }
    try {
      var values = ARTICLE_DROPDOWNS[column]();
      // La catégorie est DYNAMIQUE : la liste reste une aide à la saisie, mais
      // une valeur hors liste doit être ACCEPTÉE (setAllowInvalid(true)) au lieu
      // d'être rejetée par la feuille. Les autres colonnes (STATUT, LANG) restent
      // strictes : une faute y est un blocage de publication.
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(values, true)
        .setAllowInvalid(column === 'CATEGORY')
        .build();
      sheet.getRange(2, col, rows, 1).setDataValidation(rule);
      report.applied.push(column);
    } catch (e) {
      report.failed.push({ column: column, reason: String(e && e.message ? e.message : e) });
    }
  });

  return report;
}

/**
 * Compare l'en-tête attendu à l'en-tête réel.
 * @return {Array<{sheet:string, expected:string, found:string}>}
 */
function checkHeaders(sheet, expected, label) {
  var found = sheet.getRange(1, 1, 1, expected.length).getValues()[0].map(function (v) {
    return String(v === null ? '' : v).trim();
  });
  var drift = [];
  expected.forEach(function (name, i) {
    if (found[i] !== name) {
      drift.push({
        sheet: label,
        column: i + 1,
        expected: name,
        found: found[i] || '(vide)'
      });
    }
  });
  return drift;
}

/** Map en-tête → index de colonne (1-based) pour une feuille. */
function headerIndex(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var c = 0; c < head.length; c++) {
    var key = String(head[c] === null ? '' : head[c]).trim();
    if (key) map[key] = c + 1;
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Lecture des articles                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Lit toutes les lignes de `Articles` sous forme d'objets, pilotés par
 * l'en-tête. La ligne 1 (en-têtes) est ignorée. `__row` conserve le n° de
 * ligne pour les écritures ciblées.
 *
 * @return {Array<Object>}
 */
function readArticles() {
  var sheet = getSheetByNameOrCreate(SHEETS.ARTICLES, { create: false });
  if (!sheet || sheet.getLastRow() < 2) return [];

  var map = headerIndex(sheet);
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  var out = [];

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var any = false;
    var obj = { __row: r + 2 };
    for (var name in map) {
      if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
      var v = row[map[name] - 1];
      // Une date de cellule est CONSERVÉE comme objet `Date` : `String()` la
      // transformait en « Sat Oct 03 2026 22:00:00 GMT+0000 (…) », que plus
      // aucun contrôle `/^\d{4}-\d{2}-\d{2}$/` ne pouvait lire. La conversion
      // est faite là où la date est consommée (normalizePublishedAt()).
      if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
        obj[name] = v;
        any = true;
        continue;
      }
      var text = v === null || v === undefined ? '' : String(v).trim();
      obj[name] = text;
      if (text !== '') any = true;
    }
    if (any) out.push(obj);
  }
  return out;
}

/** Retrouve un article par ID. @return {Object|null} */
function findArticleById(id) {
  var key = String(id || '').trim();
  if (!key) return null;
  var rows = readArticles();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ID === key) return rows[i];
  }
  return null;
}

/**
 * Écrit une ou plusieurs colonnes d'un article identifié par son ID.
 * Ne crée jamais de ligne (l'ID doit exister).
 * @return {boolean} true si la ligne a été trouvée
 */
function updateArticleFields(id, fields) {
  var sheet = getSheetByNameOrCreate(SHEETS.ARTICLES, { create: false });
  if (!sheet) throw new Error('Feuille Articles introuvable');
  var article = findArticleById(id);
  if (!article) return false;

  var map = headerIndex(sheet);
  var writes = [];
  Object.keys(fields).forEach(function (name) {
    if (!Object.prototype.hasOwnProperty.call(map, name)) {
      throw new Error('Colonne inconnue : ' + name);
    }
    var value = fields[name];
    writes.push({ col: map[name], value: value === null || value === undefined ? '' : String(value) });
  });

  for (var i = 0; i < writes.length; i++) {
    sheet.getRange(article.__row, writes[i].col).setValue(writes[i].value);
  }
  return true;
}

/**
 * Liste les articles éligibles, triés par ordre de feuille (déterministe).
 * @param {string} status statut exact requis
 * @return {Array<Object>}
 */
function findArticlesByStatus(status) {
  return readArticles().filter(function (a) { return a.STATUS === status; });
}

/** Applique un verrou de script pour sérialiser les écritures. */
function withScriptLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
