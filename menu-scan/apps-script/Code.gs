/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Code.gs
 * ---------------------------------------------------------------------------
 * Points d'entrée et menus.
 *
 * PHASE 4 — actions disponibles :
 *   - Configurer les Script Properties
 *   - Configurer la planification ET armer/retirer le déclencheur quotidien
 *     (Scheduler.gs — le déclencheur n'est jamais créé implicitement)
 *   - Initialiser les feuilles (Articles / Config / Logs)
 *   - Tester la connexion GitHub (LECTURE SEULE)
 *   - Vérifier le gabarit d'article
 *   - Valider les articles
 *   - Publier l'article sélectionné
 *   - Publier le prochain article READY
 *   - Voir les erreurs
 *
 * Publication automatique (D6-B) :
 *   - `runScheduledPublication()` est le SEUL handler du déclencheur quotidien.
 *     Il est sans interface, prend un verrou de DOCUMENT, puis délègue à
 *     `publishArticleById()` (Publisher.gs) sans réécrire la publication ;
 *   - le plafond est min(ARTICLES_PER_WEEK / nbJours, MAX_ARTICLES_PER_RUN) et
 *     chaque publication porte sur UN SEUL article ;
 *   - la publication reste bloquée tant que TEST_MODE = TRUE ou
 *     GITHUB_WRITE_ENABLED = FALSE, et AUTO_PUBLISH = FALSE arrête le lot.
 */

/* -------------------------------------------------------------------------- */
/* Menu                                                                       */
/* -------------------------------------------------------------------------- */

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('🚀 Blog Menu Scan')
      .addItem('⚙️ Configuration', 'menuConfiguration')
      .addItem('🗓️ Planification / Automatisation', 'openSchedulerConfigDialog')
      .addItem('📋 Initialiser les feuilles', 'menuBootstrapSheets')
      .addSeparator()
      .addItem('🔌 Tester la connexion GitHub', 'menuTestGithub')
      .addItem('📄 Vérifier le gabarit d\'article', 'menuCheckTemplate')
      .addItem('✅ Valider les articles', 'menuValidateArticles')
      .addItem('🚀 Publier l\'article sélectionné', 'publishSelectedArticle')
      .addItem('🚀 Publier le prochain article READY', 'publishNextReadyArticle')
      .addSeparator()
      .addItem('🗑️ Supprimer l\'article publié', 'deleteSelectedPublishedArticle')
      .addSeparator()
      .addItem('⚠️ Voir les erreurs', 'menuShowErrors')
      .addToUi();
  } catch (e) {
    console.error(redact(e.message));
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

function menuConfiguration() {
  showDialog('Configuration', buildConfigurationHtml());
}

/**
 * Supprime l'article PUBLIÉ situé sur la ligne sélectionnée (D5).
 *
 * Cette entrée est volontairement ISOLÉE des actions de publication, par un
 * séparateur de part et d'autre : une suppression définitive ne doit jamais
 * être à un clic d'une publication, ni se confondre avec elle.
 *
 * Le parcours comporte DEUX étapes et une seule confirmation :
 *   1. sélection + validation SANS aucun appel GitHub, puis affichage du chemin
 *      exact qui sera supprimé ;
 *   2. confirmation explicite → `deleteArticleById(id)`, qui RELIT la ligne et
 *      revalide tout avant d'écrire.
 *
 * L'opérateur ne saisit jamais de chemin : le chemin affiché est celui de la
 * colonne GITHUB_PATH, après contrôle d'identité.
 */
function deleteSelectedPublishedArticle() {
  try {
    var selection = selectActivePublishedArticle();
    if (!selection.ok) {
      logWarning('delete_selected', selection.error, {});
      alertOrLog('Suppression : ÉCHEC\n\n' + selection.error);
      return failure('NO_SELECTION', selection.error, null);
    }

    var shown = showDeleteArticleDialog(selection.article.ID);
    if (!shown.ok) {
      logWarning('delete_selected', shown.error, {});
      alertOrLog('Suppression : ÉCHEC\n\n' + shown.error);
      return failure('NO_SELECTION', shown.error, selection.article);
    }

    // Ici s'arrête l'entrée de menu : la suppression n'a lieu qu'après
    // validation explicite dans le dialogue (bouton SUPPRIMER DÉFINITIVEMENT).
    return { ok: true, code: 'AWAITING_CONFIRMATION', message: shown.path };
  } catch (e) {
    var message = redact(String(e && e.message ? e.message : e));
    logError('delete_selected', message, {});
    alertOrLog('Suppression : ÉCHEC\n\n' + message);
    return failure('UNEXPECTED', message, null);
  }
}

/** Crée les feuilles manquantes et les en-têtes attendus. */
function menuBootstrapSheets() {
  try {
    var report = withScriptLock(function () { return bootstrapSheets(); });
    logInfo('bootstrap', 'Feuilles vérifiées', {
      creees: report.created,
      ecarts_entetes: report.missingHeaders
    });
    alertOrLog(
      'Initialisation terminée.\n\n' +
      'Feuilles créées : ' + (report.created.join(', ') || 'aucune') + '\n' +
      (report.missingHeaders.length
        ? 'Écarts d\'en-tête détectés : ' + report.missingHeaders.length
        : 'En-têtes conformes.')
    );
  } catch (e) {
    logError('bootstrap', redact(e.message));
    alertOrLog('Échec : ' + redact(e.message));
  }
}

/** Test GitHub en lecture seule. N'écrit rien. */
function menuTestGithub() {
  try {
    var result = testGithubConnection();
    logEvent({
      level: result.ok ? LEVEL.SUCCESS : LEVEL.ERROR,
      action: 'test_github',
      message: result.ok ? 'Connexion GitHub OK' : 'Connexion GitHub en échec',
      details: result
    });
    alertOrLog(formatConnectionReport(result));
  } catch (e) {
    logError('test_github', redact(e.message));
    alertOrLog('Échec : ' + redact(e.message));
  }
}

/** Charge et valide le gabarit depuis GitHub (lecture seule). */
function menuCheckTemplate() {
  try {
    var loaded = loadArticleTemplate();
    if (!loaded.ok) {
      logError('check_template', loaded.error, { githubPath: loaded.path });
      alertOrLog('Gabarit : ÉCHEC\n\n' + loaded.error);
      return;
    }
    logInfo('check_template', 'Gabarit conforme', {
      path: loaded.path, sha: loaded.sha, size: loaded.size
    });
    alertOrLog(
      'Gabarit : conforme\n\n' +
      'Chemin : ' + loaded.path + '\n' +
      'Taille : ' + loaded.size + ' octets\n' +
      'Placeholders : ' + REQUIRED_PLACEHOLDERS.length + ' attendus, tous présents\n' +
      'Robots du gabarit : ' + TEMPLATE_ROBOTS + ' (conservé, basculé au rendu)'
    );
  } catch (e) {
    logError('check_template', redact(e.message));
    alertOrLog('Échec : ' + redact(e.message));
  }
}

/** Valide toutes les lignes Articles (aucune écriture). */
function menuValidateArticles() {
  try {
    var rows = readArticles();
    if (!rows.length) {
      alertOrLog('Aucun article dans la feuille « Articles ».');
      return;
    }

    var failures = 0;
    var lines = [];
    rows.forEach(function (row) {
      var v = validateArticle(row);
      if (v.ok) {
        lines.push('OK   ' + (row.ID || '(sans ID)') + ' → ' + (v.path || ''));
      } else {
        failures += 1;
        lines.push('ÉCHEC ' + (row.ID || '(sans ID)') + ' : ' +
          v.errors.map(function (e) { return e.code; }).join(', '));
        v.errors.forEach(function (e) {
          logError('validate', e.message, { articleId: row.ID, slug: row.SLUG });
        });
      }
      (v.warnings || []).forEach(function (w) {
        logWarning('validate', w.message, { articleId: row.ID, slug: row.SLUG });
      });
    });

    logInfo('validate', 'Validation terminée : ' + (rows.length - failures) +
      '/' + rows.length + ' valides', { total: rows.length, echecs: failures });
    alertOrLog(
      'Validation : ' + (rows.length - failures) + '/' + rows.length + ' article(s) valide(s)\n\n' +
      lines.slice(0, 20).join('\n') +
      (lines.length > 20 ? '\n… ' + (lines.length - 20) + ' ligne(s) de plus' : '')
    );
  } catch (e) {
    logError('validate', redact(e.message));
    alertOrLog('Échec : ' + redact(e.message));
  }
}

function menuShowErrors() {
  try {
    var errors = readErrorLogs(20);
    if (!errors.length) {
      alertOrLog('Aucune erreur enregistrée.');
      return;
    }
    var lines = errors.map(function (e) {
      return e.TIMESTAMP + ' — ' + e.ACTION + ' — ' + e.MESSAGE;
    });
    alertOrLog('Erreurs récentes (' + errors.length + ') :\n\n' + lines.join('\n'));
  } catch (e) {
    alertOrLog('Échec : ' + redact(e.message));
  }
}

/* -------------------------------------------------------------------------- */
/* Présentation                                                               */
/* -------------------------------------------------------------------------- */

function formatConnectionReport(result) {
  var c = result.checks;
  var lines = [
    'Dépôt       : ' + c.owner + '/' + c.repository + ' (' + c.branch + ')',
    'API         : ' + c.apiBase,
    'Token       : ' + (c.tokenConfigured ? 'configuré' : 'ABSENT'),
    'Joignable   : ' + (c.reachable ? 'oui' : 'NON'),
    'Écriture    : ' + (c.canPush ? 'autorisée' : 'refusée'),
    'Verrou      : ' + (writesEnabled() ? 'OUVERT' : 'fermé (GITHUB_WRITE_ENABLED=FALSE)')
  ];
  if (result.errors.length) {
    lines.push('', 'Anomalies :', '- ' + result.errors.join('\n- '));
  }
  lines.push('', 'Aucun fichier n\'a été modifié.');
  return lines.join('\n');
}

function buildConfigurationHtml() {
  var rows = [
    ['PROP', 'GITHUB_TOKEN', propGet(PROP_KEYS.TOKEN) ? 'configuré' : 'ABSENT'],
    ['PROP', PROP_KEYS.OWNER, propGet(PROP_KEYS.OWNER) || APP.OWNER + ' (défaut)'],
    ['PROP', PROP_KEYS.REPOSITORY, propGet(PROP_KEYS.REPOSITORY) || APP.REPOSITORY + ' (défaut)'],
    ['PROP', PROP_KEYS.BRANCH, propGet(PROP_KEYS.BRANCH) || APP.BRANCH + ' (défaut)'],
    ['PROP', PROP_KEYS.API_BASE, propGet(PROP_KEYS.API_BASE) || APP.API_BASE + ' (défaut)'],
    ['PROP', PROP_KEYS.SPREADSHEET_ID, propGet(PROP_KEYS.SPREADSHEET_ID) || '(script lié)'],
    ['PROP', PROP_KEYS.WRITE_ENABLED, writesEnabled() ? 'TRUE' : 'FALSE (verrou fermé)'],
    ['CONFIG', 'TEST_MODE', getConfigValue('TEST_MODE') + (getConfigBoolean('TEST_MODE') ? ' (aucune écriture)' : ' (écriture autorisée)')]
  ];

  var config = readConfigMap();
  var configRows = CONFIG_KEYS.map(function (k) {
    return ['CONFIG', k, String(config[k])];
  });

  var html = '<div style="font-family:Roboto,Arial,sans-serif;font-size:13px">' +
    '<h3>Script Properties</h3>' +
    '<p style="color:#666">Le token n\'est jamais affiché. ' +
    'Renseignez-le via <b>Script Properties</b> (clé <code>' + PROP_KEYS.TOKEN +
    '</code>).</p>' + tableHtml(rows) +
    '<h3>Feuille Config</h3>' + tableHtml(configRows) +
    '<p style="color:#666">Clés legacy (jamais exécutées) : ' +
    CONFIG_LEGACY.join(', ') + '.</p>' +
    '<p style="color:#666">Verrou d\'écriture : <b>' +
    (writesEnabled() ? 'OUVERT' : 'fermé') + '</b> — une publication exige ' +
    'GITHUB_WRITE_ENABLED=TRUE <b>et</b> TEST_MODE=FALSE.</p>' +
    '</div>';
  return html;
}

function tableHtml(rows) {
  var out = '<table style="border-collapse:collapse;width:100%">';
  rows.forEach(function (r) {
    out += '<tr>';
    r.forEach(function (cell, i) {
      var style = i === 0
        ? 'padding:3px 8px;color:#888;'
        : 'padding:3px 8px;border-top:1px solid #eee;';
      out += '<td style="' + style + '">' + escHtml(cell) + '</td>';
    });
    out += '</tr>';
  });
  return out + '</table>';
}

function showDialog(title, html) {
  try {
    SpreadsheetApp.getUi().showModalDialog(
      HtmlService.createHtmlOutput(html).setWidth(560).setHeight(520),
      title
    );
  } catch (e) {
    // Hors contexte de tableur (exécution manuelle) : on retombe sur le journal.
    logInfo('ui', title, 'Interface indisponible : ' + redact(e.message));
  }
}

/** Affiche une alerte si le contexte UI existe, sinon journalise. */
function alertOrLog(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    console.log(redact(message));
  }
}
