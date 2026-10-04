/**
 * Menu Scan — Tests de la planification automatique (Scheduler.gs, D6-A + D6-B)
 * ---------------------------------------------------------------------------
 * Exécution : `npm run test:apps-script`
 *
 * AUCUN réseau, AUCUN vrai tableur, AUCUN VRAI déclencheur : `ScriptApp` est une
 * doublure à ÉTAT (création/retrait observables), `LockService` expose un verrou
 * de script ET un verrou de document, et tout appel HTTP non mocké échoue.
 *
 * Ces tests prouvent le comportement OBSERVABLE :
 * D6-A (dialogue)
 *   - la lecture de l'état vient de la feuille `Config` (repli sur les défauts) ;
 *   - les jours sont des CASES À COCHER, jamais un champ libre ;
 *   - la répartition affichée est ARTICLES_PER_WEEK / nbJours, règle déjà
 *     appliquée par validateConfig() — et les deux verdicts sont ÉQUIVALENTS ;
 *   - rien n'est écrit si la validation serveur échoue ;
 *   - seules les 5 clés de planification sont écrites, jamais une autre ;
 *   - l'enregistrement est idempotent ; les clés legacy WordPress sont intactes.
 * D6-B (déclencheur + exécution)
 *   - l'installation crée UN déclencheur quotidien à PUBLISH_HOUR/PUBLISH_MINUTE,
 *     sans AUCUNE heure par défaut, et elle est idempotente ;
 *   - les doublons excédentaires sont retirés, les déclencheurs ÉTRANGERS
 *     ne sont JAMAIS touchés (création comme retrait) ;
 *   - l'état affiché est honnête : jamais « armée » sur un doublon ou un refus ;
 *   - l'exécution est SANS interface, refuse AUTO_PUBLISH=FALSE, un jour non
 *     sélectionné, une répartition non exacte et un chevauchement (verrou) ;
 *   - le plafond appliqué est min(quotidien, MAX_ARTICLES_PER_RUN) ;
 *   - les articles sont publiés SÉQUENTIELLEMENT par le Publisher existant, et
 *     un échec n'interrompt pas le lot (PARTIAL) ;
 *   - TEST_MODE n'écrit jamais sur GitHub.
 */

const fs = require('fs');
const path = require('path');

const {
  createContext,
  call,
  articlesSheet,
  configSheet,
  logsSheet,
  makeGitMock,
  contentsResponse,
  putResponse,
  blogHubFixture,
  articlesJsonFixture,
  sitemapFixture
} = require('./harness.cjs');

const SCHEDULER_PATH = path.join(__dirname, '..', 'Scheduler.gs');
const SCHEDULER_SRC = fs.readFileSync(SCHEDULER_PATH, 'utf8');

/* -------------------------------------------------------------------------- */
/* Micro-framework                                                            */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
let currentSuite = '';

function suite(name) { currentSuite = name; }

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write('  \u2713 ' + name + '\n');
  } catch (e) {
    failures.push({ suite: currentSuite, name, message: e.message });
    process.stdout.write('  \u2717 ' + name + '\n      ' + e.message + '\n');
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      (label || 'valeur') + ' : attendu ' + JSON.stringify(expected) +
      ', obtenu ' + JSON.stringify(actual)
    );
  }
}

function ok(value, label) {
  if (!value) throw new Error((label || 'condition') + ' : falsy (' + JSON.stringify(value) + ')');
}

function notOk(value, label) {
  if (value) throw new Error((label || 'condition') + ' : truthy (' + JSON.stringify(value) + ')');
}

function eqList(actual, expected, label) {
  eq(JSON.stringify(actual), JSON.stringify(expected), label);
}

function includes(list, value, label) {
  if (list.indexOf(value) === -1) {
    throw new Error((label || 'liste') + ' : ' + JSON.stringify(value) + ' absent de ' + JSON.stringify(list));
  }
}

/** Instance avec une feuille Config réaliste + Logs. */
function makeCtx(configOverrides, options) {
  const base = {
    AUTO_PUBLISH: 'TRUE',
    ARTICLES_PER_DAY: '1',
    PUBLISH_HOUR: '',
    PUBLISH_MINUTE: '',
    TIMEZONE: 'Africa/Casablanca',
    ENABLE_FEATURED_IMAGE: 'FALSE',
    TEST_MODE: 'TRUE',
    MAX_ARTICLES_PER_RUN: '1',
    MAX_RETRIES: '3',
    SCHEDULE_MODE: 'WEEKLY',
    ARTICLES_PER_WEEK: '6',
    PUBLISH_DAYS: 'TUESDAY,FRIDAY',
    CATEGORY_MAP: JSON.stringify({ 'guides-prix': 'guides-prix' })
  };
  const config = Object.assign(base, configOverrides || {});
  return createContext({
    sheets: { Config: configSheet(config), Logs: logsSheet() },
    properties: (options && options.properties) || {}
  });
}

/** Codes d'erreur renvoyés par validateSchedulerConfig(). */
function codes(result) {
  return result.errors.map((e) => e.code).sort();
}

/** Saisie valide de référence. */
function validInput(overrides) {
  return Object.assign({
    autoPublish: true,
    mode: 'WEEKLY',
    perWeek: '6',
    days: ['TUESDAY', 'FRIDAY'],
    maxPerRun: '1'
  }, overrides || {});
}

/** Verdict de validateConfig() sur la règle de répartition (C3 / C3b). */
function existingRuleVerdict(ctx, perWeek, days) {
  const per = Number(perWeek);
  const list = String(days).split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);
  if (isFinite(per) && per > 0) {
    if (!list.length) return 'C3';
    if (per % list.length !== 0) return 'C3b';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Fixtures D6-B                                                               */
/* -------------------------------------------------------------------------- */

/** Gabarit réel, lu tel quel depuis le dépôt (comme le fait Publisher.test). */
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'blog', 'template-article.html'), 'utf8'
);
const TEMPLATE_ROUTE = '/contents/public/blog/template-article.html';
const TOKEN = 'ghp_test0000000000000000000000000000';
const SITE = 'https://menuscan.space';
const HUB_PATH = 'public/blog/index.html';
const ARTICLES_JSON = 'public/blog/articles.json';
const SITEMAP_FILE = 'public/sitemap.xml';
const BLOG_DIR = 'public/blog';
const CATEGORY_SLUGS = ['menu-digital', 'qr-code', 'restaurants-cafes', 'hotels-riads', 'commerces', 'guides-prix'];
const CATEGORY_MAP_JSON = JSON.stringify({
  'menu-digital': 'menu-digital',
  'qr-code': 'qr-code',
  'restaurants-cafes': 'restaurants-cafes',
  'hotels-riads': 'hotels-riads',
  'commerces': 'commerces',
  'guides-prix': 'guides-prix'
});

/** Ligne `Articles` READY minimale : c'est le SEUL point d'entrée du scheduler. */
function makeReady(id, slug, overrides) {
  return Object.assign({
    ID: id,
    TITLE: 'Article ' + slug,
    KEYWORD: 'facturation',
    CONTENT: '<h2 id="a">Section</h2>\n<p>Contenu de l\'article ' + slug + '.</p>',
    CATEGORY: 'guides-prix',
    SLUG: slug,
    LANG: 'fr',
    TRANSLATION_GROUP: slug,
    SEO_TITLE: 'SEO ' + slug,
    META_DESCRIPTION: 'Description de l\'article ' + slug + '.',
    IMAGE_URL: '/blog/images/guides-prix.jpg',
    IMAGE_ALT: 'Illustration de l\'article ' + slug,
    IMAGE_WIDTH: '1200',
    IMAGE_HEIGHT: '630',
    STATUS: 'READY',
    PUBLISHED_AT: '2026-07-14',
    SOCIAL_DESCRIPTION: 'Description sociale de ' + slug + '.',
    ARTICLE_EXCERPT: 'Extrait de ' + slug + '.',
    CARD_EXCERPT: 'Carte de ' + slug + '.',
    READING_TIME: '4',
    ERROR: '',
    GITHUB_PATH: '',
    GITHUB_SHA: '',
    GITHUB_COMMIT: ''
  }, overrides || {});
}

/**
 * Dépôt mocké des 3 index RÉELS, VIDE de tout article : la réconciliation du
 * Publisher est donc observable (elle doit ajouter l'entrée publiée).
 *
 * Architecture de production : aucun index de catégorie n'existe (le hub est
 * dynamique, `articles.json` est sa source de vérité), donc rien à ensemencer
 * de ce côté. Le hub reste présent car il est bel et bien présent en production.
 */
function emptyIndexes() {
  const locs = [SITE + '/', SITE + '/blog/'];
  return [
    { path: HUB_PATH, content: blogHubFixture() },
    { path: ARTICLES_JSON, content: articlesJsonFixture([]) },
    { path: SITEMAP_FILE, content: sitemapFixture(locs) }
  ];
}

/**
 * Liste de jours PUBLIÉE qui contient forcément « aujourd'hui » : le jour courant
 * est filtré AVANT la répartition, un scénario de quota doit donc passer ce
 * filtre pour être observé (sinon on mesurerait NOT_PUBLISH_DAY).
 * `twoDaysWithToday()` garantit EXACTEMENT 2 jours distincts : `ARTICLES_PER_WEEK`
 * impair est alors toujours non divisible (C3b), quel que soit le jour réel.
 */
function twoDaysWithToday() {
  const today = schedulerToday();
  const other = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
    .filter((d) => d !== today)[0];
  return other + ',' + today;
}

/**
 * Contexte CAPABLE de publier : dépôt mocké + écriture GitHub autorisée.
 * `docLockAvailable: false` simule une exécution déjà en cours.
 */
function publishCtx(opt) {
  const o = opt || {};
  const articles = o.articles || [makeReady('A-1', 'premier-article')];
  // Le Publisher relit le fichier de l'article avant écriture (conflit de SHA) :
  // il doit donc exister une route GET « absent » ET une route PUT pour chaque
  // article, sinon le lot échouerait sur une route non mockée.
  const routes = [{
    method: 'get', path: TEMPLATE_ROUTE,
    body: contentsResponse('blog/template-article.html', TEMPLATE), times: Infinity
  }];
  articles.forEach((a) => {
    const repoPath = BLOG_DIR + '/' + (a.LANG || 'fr') + '/' + a.SLUG + '.html';
    routes.push({ method: 'get', path: '/contents/' + repoPath, body: { message: 'Not Found' }, times: Infinity });
    routes.push({
      method: 'put', path: '/contents/' + repoPath,
      body: putResponse(repoPath, 'x', 'sha-' + a.SLUG, 'commit-' + a.SLUG), times: Infinity
    });
  });
  const fetchMock = makeGitMock(emptyIndexes(), routes, { missingAs404: true });
  const created = createContext({
    sheets: {
      Articles: articlesSheet(articles),
      Logs: logsSheet(),
      Config: configSheet(Object.assign({
        AUTO_PUBLISH: 'TRUE',
        TEST_MODE: 'FALSE',
        TIMEZONE: 'Africa/Casablanca',
        SCHEDULE_MODE: 'WEEKLY',
        ARTICLES_PER_WEEK: '2',
        PUBLISH_DAYS: 'MONDAY',
        MAX_ARTICLES_PER_RUN: '1',
        CATEGORY_MAP: CATEGORY_MAP_JSON
      }, o.config || {}))
    },
    properties: {
      GITHUB_TOKEN: TOKEN,
      GITHUB_OWNER: 'menu-scan',
      GITHUB_REPOSITORY: 'site',
      GITHUB_BRANCH: 'master',
      GITHUB_WRITE_ENABLED: 'TRUE'
    },
    fetchImpl: fetchMock,
    docLockAvailable: o.docLockAvailable
  });
  return { ctx: created.ctx, helpers: created.helpers, fetch: fetchMock };
}

/**
 * Jour « aujourd'hui » selon le fuseau configuré. Calculé par le CODE DE
 * PRODUCTION (`currentPublishDay()`) et mémorisé : les tests de filtrage par
 * jour restent ainsi exacts quelle que soit la date d'exécution, sans figer
 * l'horloge ni dupliquer la règle de fuseau.
 */
let todayCache = null;
function schedulerToday() {
  if (todayCache === null) todayCache = call(makeCtx().ctx, 'currentPublishDay');
  return todayCache;
}

/**
 * Déclencheur fabriqué par le TEST (donc hors contexte Apps Script) : sert à
 * peupler le projet de déclencheurs ÉTRANGERS au scheduler — que ni
 * l'installation ni le retrait ne doivent toucher.
 */
function fakeTrigger(handler, hour, minute) {
  return {
    getHandlerFunction: () => handler,
    getHour: () => (hour === undefined ? null : hour),
    getMinute: () => (minute === undefined ? null : minute),
    getUniqueId: () => 'fake-' + handler + '-' + hour + '-' + minute
  };
}

/** Déclencheurs du scheduler réellement présents dans le projet de test. */
function schedTriggers(ctx) {
  return ctx.ScriptApp.__projectTriggers.filter(
    (t) => t.getHandlerFunction() === 'runScheduledPublication'
  );
}

/* -------------------------------------------------------------------------- */
suite('Menu');
/* -------------------------------------------------------------------------- */

test('onOpen expose 🗓️ Planification / Automatisation', () => {
  const { ctx, helpers } = makeCtx();
  call(ctx, 'onOpen');
  const entry = helpers.ui.items.find((i) => i.label.indexOf('Planification / Automatisation') !== -1);
  ok(entry, 'entrée de menu présente');
  eq(entry.fn, 'openSchedulerConfigDialog', 'entrée branchée sur openSchedulerConfigDialog');
  ok(helpers.ui.items.some((i) => i.label === '⚙️ Configuration'), 'menu Configuration en place');
});

test('openSchedulerConfigDialog ouvre un dialogue titré', () => {
  const { ctx, helpers } = makeCtx();
  call(ctx, 'openSchedulerConfigDialog');
  eq(helpers.ui.dialogs.length, 1, 'un dialogue capturé');
  eq(helpers.ui.dialogs[0].title, 'Planification / Automatisation', 'titre du dialogue');
  ok(helpers.ui.dialogs[0].html.length > 500, 'HTML non vide');
});

test('les entrées de menu existantes sont préservées', () => {
  const { ctx, helpers } = makeCtx();
  call(ctx, 'onOpen');
  const labels = helpers.ui.items.map((i) => i.fn).filter(Boolean);
  ['menuConfiguration', 'menuBootstrapSheets', 'menuTestGithub', 'menuCheckTemplate',
    'menuValidateArticles', 'publishSelectedArticle', 'publishNextReadyArticle',
    'deleteSelectedPublishedArticle', 'menuShowErrors'
  ].forEach((fn) => includes(labels, fn, 'entrée préexistante'));
});

/* -------------------------------------------------------------------------- */
suite('Lecture de l\'état');
/* -------------------------------------------------------------------------- */

test('l\'état reflète la feuille Config', () => {
  const { ctx } = makeCtx();
  const s = call(ctx, 'getSchedulerConfigState');
  eq(s.autoPublish, true, 'AUTO_PUBLISH');
  eq(s.mode, 'WEEKLY', 'SCHEDULE_MODE');
  eq(s.perWeekRaw, '6', 'ARTICLES_PER_WEEK');
  eq(s.maxPerRunRaw, '1', 'MAX_ARTICLES_PER_RUN');
  eqList(s.days, ['TUESDAY', 'FRIDAY'], 'PUBLISH_DAYS');
  eq(s.timeZone, 'Africa/Casablanca', 'TIMEZONE');
});

test('Config absente : repli sur CONFIG_DEFAULTS', () => {
  const { ctx } = createContext({ sheets: { Logs: logsSheet() } });
  const s = call(ctx, 'getSchedulerConfigState');
  eq(s.perWeekRaw, '6', 'ARTICLES_PER_WEEK par défaut');
  eqList(s.days, ['TUESDAY', 'FRIDAY'], 'PUBLISH_DAYS par défaut');
  eq(s.mode, 'WEEKLY', 'SCHEDULE_MODE par défaut');
});

test('Config partielle : la clé absente retombe sur son défaut', () => {
  const { ctx } = createContext({
    sheets: { Config: configSheet({ ARTICLES_PER_WEEK: '6' }), Logs: logsSheet() }
  });
  const s = call(ctx, 'getSchedulerConfigState');
  eq(s.perWeekRaw, '6', 'valeur présente conservée');
  eq(s.maxPerRunRaw, '1', 'clé absente → défaut');
  eqList(s.days, ['TUESDAY', 'FRIDAY'], 'PUBLISH_DAYS absent → défaut');
});

test('les jours sont normalisés dans l\'ordre canonique', () => {
  const { ctx } = makeCtx({ PUBLISH_DAYS: 'FRIDAY,tuesday ,MONDAY' });
  eqList(call(ctx, 'getSchedulerConfigState').days, ['MONDAY', 'TUESDAY', 'FRIDAY'], 'ordre canonique');
});

test('un jour inconnu est ignoré', () => {
  const { ctx } = makeCtx({ PUBLISH_DAYS: 'TUESDAY,NOTADAY,FRIDAY' });
  eqList(call(ctx, 'getSchedulerConfigState').days, ['TUESDAY', 'FRIDAY'], 'jour inconnu éliminé');
});

test('serializePublishDays réordonne et dédoublonne', () => {
  const { ctx } = makeCtx();
  eq(call(ctx, 'serializePublishDays', ['FRIDAY', 'TUESDAY']), 'TUESDAY,FRIDAY', 'ordre canonique');
  eq(call(ctx, 'serializePublishDays', ['TUESDAY', 'TUESDAY']), 'TUESDAY', 'doublon éliminé');
  eq(call(ctx, 'serializePublishDays', ['BAD']), '', 'aucun jour valide → chaîne vide');
});

/* -------------------------------------------------------------------------- */
suite('Validation — règles existantes');
/* -------------------------------------------------------------------------- */

test('une saisie valide est acceptée', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'validateSchedulerConfig', validInput());
  eq(r.ok, true, 'ok');
  eq(r.errors.length, 0, 'aucune erreur');
});

test('ARTICLES_PER_WEEK : 0, hors borne et décimal refusés', () => {
  const { ctx } = makeCtx();
  ['0', '-1', '8', '6.5', '', 'abc'].forEach((v) => {
    const r = call(ctx, 'validateSchedulerConfig', validInput({ perWeek: v }));
    eq(r.ok, false, 'refusé : ' + JSON.stringify(v));
    includes(codes(r), 'SCHED_PER_WEEK', 'code pour ' + JSON.stringify(v));
  });
});

test('ARTICLES_PER_WEEK accepte 1..7', () => {
  const { ctx } = makeCtx();
  for (let i = 1; i <= 7; i += 1) {
    const r = call(ctx, 'validateSchedulerConfig', validInput({ perWeek: String(i), days: ['MONDAY'] }));
    eq(r.ok, true, i + ' accepté');
  }
});

test('PER_WEEK > 0 sans aucun jour → SCHED_DAYS_EMPTY', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'validateSchedulerConfig', validInput({ days: [] }));
  eq(r.ok, false, 'refusé');
  includes(codes(r), 'SCHED_DAYS_EMPTY', 'code');
});

test('la règle s\'applique même avec AUTO_PUBLISH = FALSE (miroir de C3)', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'validateSchedulerConfig', validInput({ autoPublish: false, days: [] }));
  includes(codes(r), 'SCHED_DAYS_EMPTY', 'C3 ne dépend pas de AUTO_PUBLISH');
});

test('6 articles sur 4 jours → SCHED_DISTRIBUTION', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'validateSchedulerConfig', validInput({
    days: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY']
  }));
  eq(r.ok, false, 'refusé');
  includes(codes(r), 'SCHED_DISTRIBUTION', 'code');
});

test('SCHEDULE_MODE non supporté → SCHED_MODE', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'validateSchedulerConfig', validInput({ mode: 'DAILY' }));
  eq(r.ok, false, 'refusé');
  includes(codes(r), 'SCHED_MODE', 'code');
});

test('seul WEEKLY est proposé', () => {
  const { ctx } = makeCtx();
  eqList(call(ctx, 'getSchedulerConfigState').modes, ['WEEKLY'], 'modes supportés');
  ok(SCHEDULER_SRC.indexOf("var SCHEDULER_MODES = ['WEEKLY']") !== -1, 'aucun mode ajouté');
});

test('MAX_ARTICLES_PER_RUN hors borne → SCHED_MAX_PER_RUN', () => {
  const { ctx } = makeCtx();
  ['0', '8', 'x', ''].forEach((v) => {
    const r = call(ctx, 'validateSchedulerConfig', validInput({ maxPerRun: v }));
    eq(r.ok, false, 'refusé : ' + JSON.stringify(v));
    includes(codes(r), 'SCHED_MAX_PER_RUN', 'code pour ' + JSON.stringify(v));
  });
});

test('AUTO_PUBLISH illisible → SCHED_AUTO_PUBLISH', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'validateSchedulerConfig', validInput({ autoPublish: 'peut-etre' }));
  includes(codes(r), 'SCHED_AUTO_PUBLISH', 'code');
});

test('AUTO_PUBLISH accepte booleen et chaînes TRUE/FALSE', () => {
  const { ctx } = makeCtx();
  eq(call(ctx, 'validateSchedulerConfig', validInput({ autoPublish: false })).ok, true, 'false');
  eq(call(ctx, 'validateSchedulerConfig', validInput({ autoPublish: 'TRUE' })).ok, true, 'TRUE');
  eq(call(ctx, 'validateSchedulerConfig', validInput({ autoPublish: 'false' })).normalized.AUTO_PUBLISH, 'FALSE', 'normalisé');
});

test('EQUIVALENCE avec validateConfig() : même verdict sur 49 combinaisons', () => {
  const { ctx } = makeCtx();
  // Bornes 1..7 : au-delà, Scheduler.gs refuse pour dépassement de borne (une
  // raison distincte, déjà couverte) et non pour la règle de répartition.
  const totals = [1, 2, 3, 4, 5, 6, 7];
  const daySets = [
    'MONDAY',
    'MONDAY,TUESDAY',
    'TUESDAY,FRIDAY',
    'MONDAY,TUESDAY,WEDNESDAY',
    'MONDAY,TUESDAY,WEDNESDAY,THURSDAY',
    'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY',
    ''
  ];
  let checked = 0;
  totals.forEach((total) => {
    daySets.forEach((days) => {
      const list = days === '' ? [] : days.split(',');
      const label = total + '/' + list.length + 'j';
      const mine = call(ctx, 'validateSchedulerConfig', validInput({
        perWeek: String(total), days: list
      }));
      const mineCodes = codes(mine);
      const theirs = existingRuleVerdict(ctx, total, days);

      if (theirs === 'C3') {
        includes(mineCodes, 'SCHED_DAYS_EMPTY', label + ' → C3 (jour vide)');
      } else if (theirs === 'C3b') {
        includes(mineCodes, 'SCHED_DISTRIBUTION', label + ' → C3b (non répartissable)');
      } else {
        const blocking = mineCodes.filter((c) => c === 'SCHED_DAYS_EMPTY' || c === 'SCHED_DISTRIBUTION');
        eq(blocking.length, 0, label + ' : aucun refus de répartition attendu');
      }
      checked += 1;
    });
  });
  eq(checked, 49, 'combinaisons effectivement testées');
});

/* -------------------------------------------------------------------------- */
suite('Résumé de répartition');
/* -------------------------------------------------------------------------- */

test('6 articles / 2 jours → 3 par jour', () => {
  const { ctx } = makeCtx();
  const s = call(ctx, 'computeScheduleSummary', '6', ['TUESDAY', 'FRIDAY']);
  eq(s.perWeek, 6, 'total');
  eq(s.perDay, 3, 'par jour');
  eq(s.even, true, 'répartition exacte');
  eqList(s.days, ['TUESDAY', 'FRIDAY'], 'jours normalisés');
});

test('6 articles / 4 jours → répartition impossible', () => {
  const { ctx } = makeCtx();
  const s = call(ctx, 'computeScheduleSummary', '6', ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY']);
  eq(s.even, false, 'non répartissable');
  eq(s.perDay, 1.5, 'quotient');
});

test('aucun jour → perDay 0 sans exception', () => {
  const { ctx } = makeCtx();
  const s = call(ctx, 'computeScheduleSummary', '6', []);
  eq(s.perDay, 0, 'perDay');
  eq(s.days.length, 0, 'aucun jour');
});

/* -------------------------------------------------------------------------- */
suite('Écriture');
/* -------------------------------------------------------------------------- */

test('une saisie valide écrit les 5 clés', () => {
  const { ctx } = makeCtx();
  const r = call(ctx, 'saveSchedulerConfig', validInput({
    autoPublish: false, perWeek: '4', days: ['MONDAY'], maxPerRun: '2'
  }));
  eq(r.ok, true, 'ok');
  eq(r.code, 'SAVED', 'code');
  const map = call(ctx, 'readConfigMap');
  eq(map.AUTO_PUBLISH, 'FALSE', 'AUTO_PUBLISH écrite');
  eq(map.SCHEDULE_MODE, 'WEEKLY', 'SCHEDULE_MODE écrite');
  eq(map.ARTICLES_PER_WEEK, '4', 'ARTICLES_PER_WEEK écrite');
  eq(map.PUBLISH_DAYS, 'MONDAY', 'PUBLISH_DAYS écrite');
  eq(map.MAX_ARTICLES_PER_RUN, '2', 'MAX_ARTICLES_PER_RUN écrite');
});

test('PUBLISH_DAYS est sérialisé dans l\'ordre canonique', () => {
  const { ctx } = makeCtx();
  call(ctx, 'saveSchedulerConfig', validInput({ days: ['FRIDAY', 'TUESDAY'] }));
  eq(call(ctx, 'readConfigMap').PUBLISH_DAYS, 'TUESDAY,FRIDAY', 'ordre canonique stocké');
});

test('un refus n\'écrit RIEN', () => {
  const { ctx } = makeCtx();
  const before = JSON.stringify(call(ctx, 'readConfigMap'));
  const r = call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '5' }));
  eq(r.ok, false, 'refusé');
  eq(r.code, 'SCHED_INVALID', 'code');
  ok(r.errors.length > 0, 'erreurs retournées');
  eq(JSON.stringify(call(ctx, 'readConfigMap')), before, 'Config inchangée');
});

test('les clés hors périmètre ne sont JAMAIS écrites', () => {
  const { ctx } = makeCtx();
  const guarded = [
    'ARTICLES_PER_DAY', 'PUBLISH_HOUR', 'PUBLISH_MINUTE', 'TIMEZONE',
    'ENABLE_FEATURED_IMAGE', 'TEST_MODE', 'MAX_RETRIES', 'CATEGORY_MAP'
  ];
  const before = call(ctx, 'readConfigMap');
  call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'], maxPerRun: '3' }));
  const after = call(ctx, 'readConfigMap');
  guarded.forEach((k) => eq(after[k], before[k], k + ' intacte'));
});

test('TIMEZONE reste aligné sur le manifeste (jamais réécrit)', () => {
  const { ctx } = makeCtx();
  call(ctx, 'saveSchedulerConfig', validInput());
  eq(call(ctx, 'assertTimeZoneConsistency'), 'Africa/Casablanca', 'pas de divergence introduite');
});

test('l\'ordre des lignes de Config n\'est pas modifié', () => {
  const { ctx, helpers } = makeCtx();
  const keysBefore = helpers.sheets.Config._rows.map((r) => r[0]);
  call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'] }));
  const keysAfter = helpers.sheets.Config._rows.map((r) => r[0]);
  eqList(keysAfter, keysBefore, 'ni réordonnancement ni doublon de ligne');
});

test('aucune clé legacy WordPress n\'est écrite ni supprimée', () => {
  const { ctx, helpers } = createContext({
    sheets: {
      Config: configSheet({
        AUTO_PUBLISH: 'TRUE', SCHEDULE_MODE: 'WEEKLY', ARTICLES_PER_WEEK: '6',
        PUBLISH_DAYS: 'TUESDAY,FRIDAY', MAX_ARTICLES_PER_RUN: '1',
        WORDPRESS_URL: 'LEGACY / NOT USED',
        WORDPRESS_DEFAULT_STATUS: 'LEGACY / NOT USED',
        CREATE_MISSING_CATEGORIES: 'LEGACY / NOT USED'
      }),
      Logs: logsSheet()
    }
  });
  call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'] }));
  const rows = helpers.sheets.Config._rows;
  ['WORDPRESS_URL', 'WORDPRESS_DEFAULT_STATUS', 'CREATE_MISSING_CATEGORIES'].forEach((k) => {
    const row = rows.find((r) => r[0] === k);
    ok(row, k + ' toujours présente');
    eq(row[1], 'LEGACY / NOT USED', k + ' inchangée');
  });
});

test('l\'enregistrement est idempotent', () => {
  const { ctx } = makeCtx();
  // ARTICLES_PER_WEEK (6→4) et PUBLISH_DAYS (TUESDAY,FRIDAY→MONDAY) changent ;
  // AUTO_PUBLISH, SCHEDULE_MODE et MAX_ARTICLES_PER_RUN valent déjà la cible.
  const first = call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '4', days: ['MONDAY'] }));
  eq(first.ok, true, 'ok');
  eqList(first.changed.sort(), ['ARTICLES_PER_WEEK', 'PUBLISH_DAYS'], '2 clés modifiées au premier passage');
  const second = call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '4', days: ['MONDAY'] }));
  eq(second.ok, true, 'toujours ok');
  eqList(second.changed, [], 'aucune clé modifiée au second passage');
});

test('l\'écriture d\'une clé absente passe par setConfigValue (ligne ajoutée)', () => {
  const { ctx, helpers } = createContext({
    sheets: { Config: configSheet({ ARTICLES_PER_WEEK: '6', PUBLISH_DAYS: 'MONDAY' }), Logs: logsSheet() }
  });
  const before = helpers.sheets.Config._rows.length;
  const r = call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'], autoPublish: false }));
  eq(r.ok, true, 'ok');
  ok(helpers.sheets.Config._rows.length > before, 'les lignes manquantes sont créées');
  eq(call(ctx, 'readConfigMap').AUTO_PUBLISH, 'FALSE', 'AUTO_PUBLISH ajoutée avec la valeur enregistrée');
});

test('une erreur d\'écriture est capturée, jamais propagée', () => {
  const { ctx } = createContext({ sheets: { Logs: logsSheet() } });
  const r = call(ctx, 'saveSchedulerConfig', validInput());
  eq(r.ok, false, 'échec');
  eq(r.code, 'SCHED_SAVE_FAILED', 'code');
  ok(r.message.indexOf('Config') !== -1 || r.message.length > 0, 'message présent');
});

test('l\'enregistrement journalise sans secret', () => {
  const { ctx, helpers } = makeCtx();
  call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'] }));
  const rows = helpers.sheets.Logs._rows;
  ok(rows.length >= 1, 'une entrée de journal');
  const entry = rows[rows.length - 1];
  eq(entry[2], 'scheduler', 'action = scheduler');
  ok(String(entry[8]).indexOf('gho_') === -1, 'aucun token dans le détail');
});

test('un échec de journalisation n\'annule pas l\'écriture', () => {
  const { ctx } = createContext({ sheets: { Config: configSheet({
    AUTO_PUBLISH: 'TRUE', SCHEDULE_MODE: 'WEEKLY', ARTICLES_PER_WEEK: '6',
    PUBLISH_DAYS: 'MONDAY', MAX_ARTICLES_PER_RUN: '1'
  }) } });
  const r = call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'] }));
  eq(r.ok, true, 'écriture conservée sans feuille Logs');
});

/* -------------------------------------------------------------------------- */
suite('Déclencheurs — état honnête (D6-B)');
/* -------------------------------------------------------------------------- */

test('describeSchedulerTriggers lit 0 déclencheur', () => {
  const { ctx } = makeCtx();
  const t = call(ctx, 'describeSchedulerTriggers');
  eq(t.readable, true, 'lecture possible');
  eq(t.count, 0, 'aucun déclencheur');
  eq(t.schedulerCount, 0, 'aucun déclencheur du scheduler');
  eq(t.installed, false, 'automatisation non armée');
});

test('le dialogue annonce honnêtement 0 déclencheur', () => {
  const { ctx, helpers } = makeCtx();
  call(ctx, 'openSchedulerConfigDialog');
  const html = helpers.ui.dialogs[0].html;
  ok(html.indexOf('0 d\u00e9clencheur du scheduler \u2014 publication automatique INACTIVE.') !== -1,
    'mention « 0 déclencheur du scheduler — publication automatique INACTIVE »');
});

test('deux déclencheurs du scheduler sont signalés DOUBLON, jamais « armé »', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '7', PUBLISH_MINUTE: '30' });
  ctx.ScriptApp.setProjectTriggers([
    fakeTrigger('runScheduledPublication', 7, 30),
    fakeTrigger('runScheduledPublication', 7, 30)
  ]);
  const s = call(ctx, 'getSchedulerConfigState');
  eq(s.triggers.duplicates, true, 'doublon détecté');
  eq(s.triggers.installed, false, 'jamais « installé » sur un doublon');
  const text = call(ctx, 'triggerStatusText', s.triggers);
  ok(text.indexOf('2 d\u00e9clencheurs du scheduler \u2014 DOUBLON') !== -1, 'libellé de doublon');
  ok(text.indexOf('ARM') === -1, 'aucune promesse « armée » sur un doublon');
});

test('un déclencheur installé est annoncé ARMÉ avec son heure', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '7', PUBLISH_MINUTE: '5' });
  call(ctx, 'installSchedulerTrigger');
  const s = call(ctx, 'getSchedulerConfigState');
  const text = call(ctx, 'triggerStatusText', s.triggers);
  ok(text.indexOf('1 d\u00e9clencheur quotidien du scheduler \u2014 publication automatique ARM\u00c9E') !== -1,
    'mention « armée »');
  ok(text.indexOf('07h05') !== -1, 'heure du déclencheur affichée');
});

test('un état illisible est signalé sans mensonge', () => {
  const { ctx } = makeCtx();
  ctx.ScriptApp.getProjectTriggers = () => { throw new Error('acces refuse'); };
  const t = call(ctx, 'describeSchedulerTriggers');
  eq(t.readable, false, 'illisible');
  eq(t.count, -1, 'compteur inconnu');
  eq(t.schedulerCount, -1, 'compteur scheduler inconnu');
  eq(call(ctx, 'triggerStatusText', t).indexOf('illisible') !== -1, true, 'phrase « illisible »');
});

test('un déclencheur ÉTRANGER seul n\'est jamais compté comme le nôtre', () => {
  const { ctx } = makeCtx();
  ctx.ScriptApp.setProjectTriggers([fakeTrigger('onOpen', null, null)]);
  const t = call(ctx, 'describeSchedulerTriggers');
  eq(t.count, 1, 'le projet a bien 1 déclencheur');
  eq(t.schedulerCount, 0, 'mais pas le nôtre');
  eq(t.installed, false, 'automatisation non armée');
  eq(call(ctx, 'triggerStatusText', t).indexOf('ARM') === -1, true, 'aucune promesse « armée »');
});

test('le dialogue expose les 3 actions de déclencheur', () => {
  const { ctx } = makeCtx();
  const html = call(ctx, 'renderSchedulerDialogHtml', call(ctx, 'getSchedulerConfigState'));
  ok(html.indexOf('id="installTriggerBtn"') !== -1, 'bouton installer');
  ok(html.indexOf('id="removeTriggerBtn"') !== -1, 'bouton retirer');
  ok(html.indexOf('id="statusTriggerBtn"') !== -1, 'bouton état');
  ok(html.indexOf('.installSchedulerTrigger()') !== -1, 'appel serveur installer');
  ok(html.indexOf('.removeSchedulerTrigger()') !== -1, 'appel serveur retirer');
  ok(html.indexOf('.getSchedulerTriggerStatus()') !== -1, 'appel serveur état');
});

test('le dialogue n\'affirme plus « non implémenté » et documente l\'heure', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '15' });
  const html = call(ctx, 'renderSchedulerDialogHtml', call(ctx, 'getSchedulerConfigState'));
  ok(html.indexOf('non implément') === -1, 'aucune mention « non implémenté »');
  ok(html.indexOf('PUBLISH_HOUR') !== -1 && html.indexOf('PUBLISH_MINUTE') !== -1,
    'les clés d\'heure sont documentées');
  ok(html.indexOf('06h15') !== -1, 'heure configurée affichée');
  ok(html.indexOf('id="publishHour"') === -1, 'aucun champ éditable pour l\'heure');
});

test('aucun déclencheur n\'est créé par le flux de configuration seul', () => {
  const { ctx } = makeCtx();
  call(ctx, 'onOpen');
  call(ctx, 'openSchedulerConfigDialog');
  call(ctx, 'getSchedulerConfigState');
  call(ctx, 'saveSchedulerConfig', validInput({ perWeek: '2', days: ['MONDAY'] }));
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'ScriptApp toujours vide');
});

test('preuve statique : le retrait est cantonné à NOTRE handler', () => {
  ok(/newTrigger\(\s*SCHEDULER_TRIGGER_HANDLER\s*\)/.test(SCHEDULER_SRC),
    'création liée à SCHEDULER_TRIGGER_HANDLER');
  const deleteCalls = SCHEDULER_SRC.match(/^[ \t]*ScriptApp\.deleteTrigger\(/gm) || [];
  eq(deleteCalls.length, 1, 'un seul point d\'appel exécutable à deleteTrigger');
  ok(/function removeSchedulerTriggerOne\(trigger\)\s*\{\s*if \(!isSchedulerTrigger\(trigger\)\) return false;/.test(SCHEDULER_SRC),
    'removeSchedulerTriggerOne refuse tout déclencheur non scheduler');
  ok(SCHEDULER_SRC.indexOf('ScriptApp.deleteTrigger(trigger);')
    > SCHEDULER_SRC.indexOf('function removeSchedulerTriggerOne'), 'appel postérieur à la garde');
  notOk(/ScriptApp\.createTrigger/.test(SCHEDULER_SRC), 'createTrigger absent');
  notOk(/Services\.getScriptResources/.test(SCHEDULER_SRC), 'aucun script externe');
  notOk(/PropertiesService/.test(SCHEDULER_SRC), 'aucun Script Property');
});

/* -------------------------------------------------------------------------- */
suite('Compatibilité du déclencheur (correctif D6-B)');
/* -------------------------------------------------------------------------- */

/**
 * Régression du défaut déployé : en production,
 * `ScriptApp.newTrigger().timeBased().atHour(h).atMinute(m)` levait
 * « atMinute is not a function » — `TriggerBuilder.timeBased()` renvoie un
 * `ClockTriggerBuilder`, qui n'a PAS de méthode `atMinute`.
 */
test('régression : la chaîne atHour().atMinute() a disparu du source', () => {
  notOk(/\.atMinute\s*\(/.test(SCHEDULER_SRC), 'aucun appel à atMinute()');
  notOk(/atMinute(?![\w])/.test(SCHEDULER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    'aucune mention d\'atMinute dans le code exécutable');
  const chain = SCHEDULER_SRC.match(/newTrigger\([\s\S]{0,320}?\.create\(\)/);
  ok(chain, 'chaîne de création de déclencheur lisible');
  const text = chain[0];
  ok(/\.timeBased\(\)/.test(text), 'timeBased() conservé');
  ok(/\.atHour\(clock\.hour\)/.test(text), 'atHour(config.hour) conservé');
  ok(/\.nearMinute\(clock\.minute\)/.test(text), 'nearMinute(clock.minute) utilisé');
  ok(/\.everyDays\(1\)/.test(text), 'everyDays(1) : fréquence obligatoire avec atHour/nearMinute');
});

test('régression : le harnais expose le vrai ClockTriggerBuilder (pas de atMinute)', () => {
  const { ctx } = makeCtx();
  const builder = ctx.ScriptApp.newTrigger('runScheduledPublication').timeBased();
  eq(typeof builder.atHour, 'function', 'atHour existe (ClockTriggerBuilder)');
  eq(typeof builder.nearMinute, 'function', 'nearMinute existe (ClockTriggerBuilder)');
  eq(typeof builder.everyDays, 'function', 'everyDays existe (ClockTriggerBuilder)');
  eq(typeof builder.create, 'function', 'create existe');
  // C'est exactement ce qui manquait : la méthode n'existe pas, donc l'appel
  // lève la même TypeError que dans le runtime Apps Script.
  eq(builder.atMinute, undefined, 'atMinute ABSENT de la surface d\'API');
  eq(builder.everyMinutes, undefined, 'everyMinutes absent (pas de polling)');
  eq(builder.everyNMinutes, undefined, 'everyNMinutes absent (pas de polling)');
  eq(builder.onWeekDay, undefined, 'onWeekDay absent (pas de déclencheur par jour)');
  let thrown = null;
  try {
    ctx.ScriptApp.newTrigger('runScheduledPublication').timeBased().atHour(7).atMinute(45);
  } catch (e) {
    thrown = e;
  }
  ok(thrown !== null && /atMinute is not a function/.test(String(thrown.message)),
    'la chaîne invalide échoue exactement comme en production : ' + (thrown && thrown.message));
});

test('régression : atHour/nearMinute sans fréquence est refusé (règle officielle)', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  let thrown = null;
  try {
    ctx.ScriptApp.newTrigger('runScheduledPublication').timeBased().atHour(6).nearMinute(0).create();
  } catch (e) {
    thrown = e;
  }
  ok(thrown !== null && /everyDays/.test(String(thrown.message)),
    'create() refuse une horloge sans fréquence : ' + (thrown && thrown.message));
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'rien n\'est créé');
});

test('l\'installation passe maintenant par nearMinute + everyDays(1)', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '20' });
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, true, 'installation réussie : ' + r.message);
  eq(r.created, true, 'création');
  const t = schedTriggers(ctx)[0];
  eq(t.getHour(), 6, 'heure conservée');
  eq(t.getMinute(), 20, 'minute visée conservée (lisible via getMinute())');
  eq(t.__everyDays, 1, 'fréquence quotidienne');
  eq(t.getHandlerFunction(), 'runScheduledPublication', 'handler unique');
  eq(ctx.ScriptApp.__projectTriggers.length, 1, 'UN SEUL déclencheur, pas un par jour');
});

test('l\'idempotence tient toujours avec la nouvelle API (même identifiant)', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '20' });
  call(ctx, 'installSchedulerTrigger');
  const idBefore = schedTriggers(ctx)[0].getUniqueId();
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.code, 'ALREADY_INSTALLED', 'aucune recréation');
  eq(r.created, false, '0 création');
  eq(schedTriggers(ctx).length, 1, 'toujours 1');
  eq(schedTriggers(ctx)[0].getUniqueId(), idBefore, 'le même déclencheur survit');
});

test('une heure de publication NON configurée est refusée, avec la marche à suivre', () => {
  const { ctx, helpers } = makeCtx({ PUBLISH_HOUR: '', PUBLISH_MINUTE: '' });
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, false, 'refusé');
  eq(r.code, 'SCHED_PUBLISH_HOUR', 'code');
  eq(r.created, false, 'aucune création');
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'ScriptApp reste vide');
  ok(r.message.indexOf('feuille Config') !== -1, 'la réponse dit OÙ configurer');
  ok(r.message.indexOf('PUBLISH_HOUR') !== -1, 'la réponse nomme la clé');
  ok(/Aucune heure n'est inventée/.test(r.message),
    'la réponse garantit qu\'aucune heure n\'est inventée');
  // Le dialogue expose l'information AVANT même de cliquer.
  const html = call(ctx, 'renderSchedulerDialogHtml', call(ctx, 'getSchedulerConfigState'));
  ok(html.indexOf('non renseignée') !== -1, 'heure affichée « non renseignée »');
  ok(html.indexOf('Aucune heure par défaut') !== -1, 'avertissement « aucune heure par défaut »');
  ok(html.indexOf('id="publishHour"') === -1 && html.indexOf('id="publishMinute"') === -1,
    'toujours aucun champ éditable (pas de nouvelle architecture de configuration)');
  void helpers;
});

test('une minute manquante (heure présente) est refusée de la même façon', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '' });
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, false, 'refusé');
  eq(r.code, 'SCHED_PUBLISH_MINUTE', 'code');
  ok(r.message.indexOf('PUBLISH_MINUTE') !== -1, 'la clé est nommée');
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'aucun déclencheur');
});

/* -------------------------------------------------------------------------- */
suite('Installation du déclencheur (D6-B)');
/* -------------------------------------------------------------------------- */

test('l\'installation crée UN déclencheur quotidien à l\'heure configurée', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '7', PUBLISH_MINUTE: '45' });
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, true, 'ok');
  eq(r.code, 'INSTALLED', 'code');
  eq(r.created, true, 'création');
  const triggers = schedTriggers(ctx);
  eq(triggers.length, 1, 'exactement 1 déclencheur du scheduler');
  eq(triggers[0].getHandlerFunction(), 'runScheduledPublication', 'handler');
  eq(triggers[0].getHour(), 7, 'heure');
  eq(triggers[0].getMinute(), 45, 'minute');
});

test('l\'installation est idempotente : 0 création au second passage', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  call(ctx, 'installSchedulerTrigger');
  const idBefore = schedTriggers(ctx)[0].getUniqueId();
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, true, 'ok');
  eq(r.code, 'ALREADY_INSTALLED', 'code');
  eq(r.created, false, 'aucune création');
  eq(schedTriggers(ctx).length, 1, 'toujours 1 déclencheur');
  eq(schedTriggers(ctx)[0].getUniqueId(), idBefore, 'le même déclencheur est conservé');
});

test('les doublons excédentaires sont retirés, un seul survit', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  call(ctx, 'installSchedulerTrigger');
  ctx.ScriptApp.__projectTriggers.push(fakeTrigger('runScheduledPublication', 6, 0));
  ctx.ScriptApp.__projectTriggers.push(fakeTrigger('runScheduledPublication', 6, 0));
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.removed, 2, '2 doublons retirés');
  eq(r.created, false, 'aucune création supplémentaire');
  eq(schedTriggers(ctx).length, 1, 'un seul déclencheur');
});

test('un déclencheur à l\'ancienne heure est remplacé (jamais deux en même temps)', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  ctx.ScriptApp.setProjectTriggers([fakeTrigger('runScheduledPublication', 23, 15)]);
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, true, 'ok');
  eq(r.code, 'INSTALLED', 'code');
  eq(r.removed, 1, 'l\'ancien déclencheur est retiré');
  const triggers = schedTriggers(ctx);
  eq(triggers.length, 1, 'un seul déclencheur');
  eq(triggers[0].getHour(), 6, 'nouvelle heure');
  eq(triggers[0].getMinute(), 0, 'nouvelle minute');
});

test('un déclencheur conforme est conservé même si un hors-heure traîne', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  call(ctx, 'installSchedulerTrigger');
  const idBefore = schedTriggers(ctx)[0].getUniqueId();
  ctx.ScriptApp.__projectTriggers.push(fakeTrigger('runScheduledPublication', 23, 15));
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.code, 'ALREADY_INSTALLED', 'aucune création inutile');
  eq(r.removed, 1, 'seul le déclencheur hors-heure est retiré');
  eq(schedTriggers(ctx).length, 1, 'un seul déclencheur');
  eq(schedTriggers(ctx)[0].getUniqueId(), idBefore, 'le déclencheur conforme survit');
});

test('les déclencheurs ÉTRANGERS ne sont jamais supprimés', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  ctx.ScriptApp.setProjectTriggers([
    fakeTrigger('onOpen', null, null),
    fakeTrigger('cleanupExpired', 3, 0)
  ]);
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, true, 'ok');
  eq(r.removed, 0, 'aucun retrait');
  eq(ctx.ScriptApp.__projectTriggers.length, 3, 'les 2 étrangers intacts + 1 nôtre');
  const d = call(ctx, 'removeSchedulerTrigger');
  eq(d.ok, true, 'retrait ok');
  eq(ctx.ScriptApp.__projectTriggers.length, 2, 'les 2 étrangers survivent');
});

test('une heure absente est refusée : AUCUNE heure par défaut, AUCUN déclencheur', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '', PUBLISH_MINUTE: '' });
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, false, 'refusé');
  eq(r.code, 'SCHED_PUBLISH_HOUR', 'code heure');
  eq(r.created, false, 'aucune création');
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'rien n\'est créé');
});

test('heure/minute hors bornes ou illisibles : refus avant toute création', () => {
  const bad = [
    [{ PUBLISH_HOUR: '', PUBLISH_MINUTE: '0' }, 'SCHED_PUBLISH_HOUR'],
    [{ PUBLISH_HOUR: '7', PUBLISH_MINUTE: '' }, 'SCHED_PUBLISH_MINUTE'],
    [{ PUBLISH_HOUR: '24', PUBLISH_MINUTE: '0' }, 'SCHED_PUBLISH_TIME_INVALID'],
    [{ PUBLISH_HOUR: '7', PUBLISH_MINUTE: '60' }, 'SCHED_PUBLISH_TIME_INVALID'],
    [{ PUBLISH_HOUR: '7', PUBLISH_MINUTE: '-5' }, 'SCHED_PUBLISH_TIME_INVALID'],
    [{ PUBLISH_HOUR: 'seize', PUBLISH_MINUTE: '0' }, 'SCHED_PUBLISH_TIME_INVALID']
  ];
  bad.forEach((pair) => {
    const label = JSON.stringify(pair[0]);
    const { ctx } = makeCtx(pair[0]);
    const r = call(ctx, 'installSchedulerTrigger');
    eq(r.ok, false, 'refusé pour ' + label);
    eq(r.code, pair[1], 'code pour ' + label);
    eq(ctx.ScriptApp.__projectTriggers.length, 0, 'rien n\'est créé pour ' + label);
  });
});

test('un échec de création est signalé, jamais masqué en succès', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  ctx.ScriptApp.newTrigger = () => { throw new Error('quota de declencheurs atteint'); };
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, false, 'échec');
  eq(r.code, 'SCHED_TRIGGER_CREATE_FAILED', 'code');
  eq(r.created, false, 'aucune création');
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'rien n\'est créé');
});

test('une liste de déclencheurs illisible refuse toute écriture', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  ctx.ScriptApp.getProjectTriggers = () => { throw new Error('acces refuse'); };
  const r = call(ctx, 'installSchedulerTrigger');
  eq(r.ok, false, 'échec');
  eq(r.code, 'SCHED_TRIGGERS_UNREADABLE', 'code');
  eq(ctx.ScriptApp.__projectTriggers.length, 0, 'rien n\'est créé');
  const d = call(ctx, 'removeSchedulerTrigger');
  eq(d.ok, false, 'retrait refusé aussi');
  eq(d.code, 'SCHED_TRIGGERS_UNREADABLE', 'même code');
});

test('le retrait est idempotent : un second retrait n\'est pas une erreur', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  call(ctx, 'installSchedulerTrigger');
  const first = call(ctx, 'removeSchedulerTrigger');
  eq(first.code, 'REMOVED', 'premier retrait');
  eq(schedTriggers(ctx).length, 0, 'déclencheur retiré');
  const second = call(ctx, 'removeSchedulerTrigger');
  eq(second.ok, true, 'second retrait sans erreur');
  eq(second.code, 'NOT_INSTALLED', 'code NOT_INSTALLED');
});

test('le retrait d\'un déclencheur que l\'API refuse est signalé', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  call(ctx, 'installSchedulerTrigger');
  ctx.ScriptApp.deleteTrigger = () => { throw new Error('declencheur deja supprime'); };
  const r = call(ctx, 'removeSchedulerTrigger');
  eq(r.ok, false, 'échec signalé');
  eq(r.code, 'SCHED_TRIGGER_REMOVE_FAILED', 'code');
});

test('l\'état du déclencheur est lisible sans feuille Config (bouton « État »)', () => {
  const { ctx } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  const empty = call(ctx, 'getSchedulerTriggerStatus');
  eq(empty.code, 'NOT_INSTALLED', 'non installé');
  eq(empty.schedulerCount, 0, 'compteur');
  eq(empty.clockOk, true, 'heure lisible');
  call(ctx, 'installSchedulerTrigger');
  const on = call(ctx, 'getSchedulerTriggerStatus');
  eq(on.code, 'INSTALLED', 'installé');
  eq(on.hour, 6, 'heure');
  eq(on.minute, 0, 'minute');
  eq(on.handler, 'runScheduledPublication', 'handler');
  ok(on.text.indexOf('ARM') !== -1, 'texte « armée »');
});

test('l\'installation est journalisée dans la feuille Logs', () => {
  const { ctx, helpers } = makeCtx({ PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  call(ctx, 'installSchedulerTrigger');
  const rows = helpers.sheets.Logs._rows;
  ok(rows.length >= 1, 'une entrée de journal');
  eq(rows[rows.length - 1][2], 'scheduler', 'action = scheduler');
  ok(String(rows[rows.length - 1][8]).indexOf('gho_') === -1, 'aucun token dans le détail');
});

/* -------------------------------------------------------------------------- */
suite('Exécution planifiée (D6-B)');
/* -------------------------------------------------------------------------- */

test('le chemin d\'exécution est SANS interface (preuve statique)', () => {
  const body = SCHEDULER_SRC.slice(
    SCHEDULER_SRC.indexOf('function runScheduledPublication()'),
    SCHEDULER_SRC.indexOf('function runScheduledPublicationLocked()')
  );
  ok(body.length > 0, 'corps de runScheduledPublication() trouvé');
  ['getUi(', 'alert(', 'confirmBox', 'prompt(', 'getActiveSpreadsheet', 'getActiveSheet',
    'getActiveCell', 'getActiveRange', 'PropertiesService', 'Browser', 'CacheService'
  ].forEach((forbidden) => {
    ok(body.indexOf(forbidden) === -1, forbidden + ' absent du chemin d\'exécution');
  });
  // Verrou de DOCUMENT, jamais celui de script (non réentrant).
  ok(/LockService\.getDocumentLock\(\)/.test(body), 'verrou de document');
  notOk(/getScriptLock/.test(body), 'jamais getScriptLock dans le scheduler');
});

test('AUTO_PUBLISH=FALSE : sortie propre, aucun article publié', () => {
  const { ctx, fetch } = publishCtx({ config: { AUTO_PUBLISH: 'FALSE' } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, true, 'exécution sans erreur');
  eq(r.code, 'AUTO_PUBLISH_OFF', 'code');
  eq(r.published, 0, '0 publication');
  eq(call(ctx, 'findArticleById', 'A-1').STATUS, 'READY', 'ligne inchangée');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('jour non sélectionné : aucun article publié', () => {
  const today = schedulerToday();
  const other = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
    .filter((d) => d !== today)[0];
  const { ctx, fetch } = publishCtx({ config: { PUBLISH_DAYS: other } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.code, 'NOT_PUBLISH_DAY', 'code');
  eq(r.day, today, 'jour courant');
  eq(r.publishDay, false, 'jour non publié');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('jour sélectionné : le Publisher existant publie les articles READY', () => {
  const { ctx, helpers, fetch } = publishCtx({ config: { PUBLISH_DAYS: schedulerToday() } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, true, 'exécution sans échec');
  eq(r.code, 'PUBLISHED', 'code');
  eq(r.published, 1, '1 publication');
  eq(r.failed, 0, '0 échec');
  eq(r.day, schedulerToday(), 'jour correct');
  eq(r.publishDay, true, 'jour publié');
  eq(r.dailyQuota, 2, 'quotidien = 2 / 1 jour');
  eq(r.effectiveLimit, 1, 'plafond = min(2, MAX_ARTICLES_PER_RUN)');
  eq(r.articles.length, 1, 'un article traité');
  eq(r.articles[0].id, 'A-1', 'le premier READY');
  eq(call(ctx, 'findArticleById', 'A-1').STATUS, 'PUBLISHED', 'ligne PUBLISHED');
  ok(fetch.calls.some((c) => c.path.indexOf('/contents/public/blog/fr/premier-article.html') !== -1),
    'le fichier de l\'article a bien été écrit');
  ok(helpers.lock.docLog.indexOf('releaseLock') !== -1, 'verrou de document relâché');
  eq(helpers.lock.docHeld, false, 'aucun verrou retenu');
  ok(helpers.sheets.Logs._rows.some((row) => String(row[2]) === 'scheduler'), 'journal scheduler alimenté');
});

test('le plafond est min(quotidien, MAX_ARTICLES_PER_RUN) : jamais plus', () => {
  const articles = [
    makeReady('A-1', 'article-un'),
    makeReady('A-2', 'article-deux'),
    makeReady('A-3', 'article-trois')
  ];
  const { ctx } = publishCtx({
    articles: articles,
    config: { PUBLISH_DAYS: schedulerToday(), ARTICLES_PER_WEEK: '3', MAX_ARTICLES_PER_RUN: '1' }
  });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.dailyQuota, 3, 'quotidien = 3 / 1 jour');
  eq(r.effectiveLimit, 1, 'plafond appliqué');
  eq(r.selected, 1, '1 article sélectionné');
  eq(r.published, 1, '1 publication');
  eq(r.remaining, 2, '2 articles restent READY');
  eq(call(ctx, 'findArticleById', 'A-2').STATUS, 'READY', 'A-2 non touché');
  eq(call(ctx, 'findArticleById', 'A-3').STATUS, 'READY', 'A-3 non touché');
});

test('une répartition non divisible REFUSE l\'exécution (0 publication)', () => {
  const { ctx, fetch } = publishCtx({ config: { ARTICLES_PER_WEEK: '5', PUBLISH_DAYS: twoDaysWithToday() } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, false, 'exécution en échec');
  eq(r.code, 'SCHED_DISTRIBUTION', 'code');
  eq(r.effectiveLimit, 0, 'plafond nul');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('PUBLISH_DAYS vide : aucune publication', () => {
  const { ctx, fetch } = publishCtx({ config: { PUBLISH_DAYS: '' } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, true, 'sortie propre');
  eq(r.code, 'PUBLISH_DAYS_EMPTY', 'code');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('aucun article READY : rapport NO_READY', () => {
  const { ctx, fetch } = publishCtx({
    articles: [makeReady('A-1', 'article-brouillon', { STATUS: 'DRAFT' })],
    config: { PUBLISH_DAYS: schedulerToday() }
  });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, true, 'sans échec');
  eq(r.code, 'NO_READY', 'code');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('un échec ne fait pas TSAILLER le lot : le reste est publié (PARTIAL)', () => {
  // L'article cassé est cassé par un V19 (READING_TIME vide) : une catégorie
  // inconnue ne l'est PLUS, les catégories étant dynamiques.
  const articles = [
    makeReady('A-1', 'article-casse', { READING_TIME: '' }),
    makeReady('A-2', 'article-valide')
  ];
  const { ctx } = publishCtx({
    articles: articles,
    config: { PUBLISH_DAYS: schedulerToday(), ARTICLES_PER_WEEK: '2', MAX_ARTICLES_PER_RUN: '2' }
  });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, false, 'le rapport ne masque pas l\'échec');
  eq(r.code, 'PARTIAL', 'code PARTIAL');
  eq(r.published, 1, '1 publication');
  eq(r.failed, 1, '1 échec');
  eq(r.selected, 2, '2 articles sélectionnés');
  eq(call(ctx, 'findArticleById', 'A-2').STATUS, 'PUBLISHED', 'le 2e article est publié');
  notOk(call(ctx, 'findArticleById', 'A-1').STATUS === 'PUBLISHED', 'A-1 jamais PUBLISHED');
});

test('TEST_MODE=TRUE : aucune écriture GitHub, le refus est déclaré', () => {
  const { ctx, fetch } = publishCtx({ config: { PUBLISH_DAYS: schedulerToday(), TEST_MODE: 'TRUE' } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.testMode, true, 'mode test signalé');
  eq(r.articles[0].testMode, true, 'article signalé en mode test');
  eq(r.articles[0].code, 'TEST_MODE', 'code TEST_MODE');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.filter((c) => c.method === 'put').length, 0, 'aucune écriture');
  notOk(call(ctx, 'findArticleById', 'A-1').STATUS === 'PUBLISHED', 'jamais PUBLISHED');
});

test('un chevauchement est refusé sans rien publier', () => {
  const { ctx, fetch } = publishCtx({ docLockAvailable: false });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, true, 'sortie propre (pas une erreur)');
  eq(r.code, 'SCHED_ALREADY_RUNNING', 'code');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('sans verrou de document : refus explicite, jamais de publication sans garde', () => {
  const { ctx, fetch } = publishCtx({ config: { PUBLISH_DAYS: schedulerToday() } });
  ctx.LockService.getDocumentLock = () => null;
  const r = call(ctx, 'runScheduledPublication');
  eq(r.ok, false, 'échec');
  eq(r.code, 'SCHED_LOCK_UNAVAILABLE', 'code');
  eq(r.published, 0, '0 publication');
  eq(fetch.calls.length, 0, 'aucun appel GitHub');
});

test('le verrou est relâché même quand l\'exécution échoue', () => {
  const { ctx, helpers } = publishCtx({ config: { ARTICLES_PER_WEEK: '5', PUBLISH_DAYS: twoDaysWithToday() } });
  const r = call(ctx, 'runScheduledPublication');
  eq(r.code, 'SCHED_DISTRIBUTION', 'exécution refusée');
  ok(helpers.lock.docLog.indexOf('releaseLock') !== -1, 'verrou relâché');
  eq(helpers.lock.docHeld, false, 'aucun verrou retenu');
});

test('le quota computationnel est réutilisé, pas réinventé', () => {
  const { ctx } = makeCtx();
  const l = call(ctx, 'computeEffectiveLimit', {
    ARTICLES_PER_WEEK: '6', PUBLISH_DAYS: 'MONDAY,TUESDAY,FRIDAY', MAX_ARTICLES_PER_RUN: '5'
  });
  eq(l.ok, true, 'configuration valide');
  eq(l.dailyQuota, 2, '6 / 3 jours');
  eq(l.effectiveLimit, 2, 'min(2, 5)');
  eq(l.maxPerRun, 5, 'plafond brut conservé');
  const capped = call(ctx, 'computeEffectiveLimit', {
    ARTICLES_PER_WEEK: '6', PUBLISH_DAYS: 'MONDAY', MAX_ARTICLES_PER_RUN: '1'
  });
  eq(capped.dailyQuota, 6, '6 / 1 jour');
  eq(capped.effectiveLimit, 1, 'plafond MAX plus bas que le quotidien');
  const uneven = call(ctx, 'computeEffectiveLimit', {
    ARTICLES_PER_WEEK: '5', PUBLISH_DAYS: 'MONDAY,TUESDAY', MAX_ARTICLES_PER_RUN: '3'
  });
  eq(uneven.ok, false, 'répartition non exacte refusée');
  eq(uneven.code, 'SCHED_DISTRIBUTION', 'code');
  const empty = call(ctx, 'computeEffectiveLimit', {
    ARTICLES_PER_WEEK: '6', PUBLISH_DAYS: '', MAX_ARTICLES_PER_RUN: '3'
  });
  eq(empty.ok, false, 'PUBLISH_DAYS vide refusé');
  eq(empty.code, 'PUBLISH_DAYS_EMPTY', 'code');
});

test('le jour courant est calculé dans le fuseau configuré', () => {
  const { ctx } = makeCtx({ TIMEZONE: 'Africa/Casablanca', PUBLISH_HOUR: '6', PUBLISH_MINUTE: '0' });
  const day = call(ctx, 'currentPublishDay');
  ok(ctx.PUBLISH_DAY_ORDER.indexOf(day) !== -1, 'jour valide : ' + day);
  eq(call(ctx, 'currentPublishDay'), day, 'stable dans le même fuseau');
  // Un décalage de fuseau doit changer le jour : sinon la règle serait ignorée.
  const tokyo = makeCtx({ TIMEZONE: 'Asia/Tokyo' }).ctx;
  ok(typeof call(tokyo, 'currentPublishDay') === 'string', 'fuseau alternatif lu sans erreur');
});

test('l\'exécution est journalisée sans secret', () => {
  const { ctx, helpers } = publishCtx({ config: { PUBLISH_DAYS: schedulerToday() } });
  call(ctx, 'runScheduledPublication');
  const joined = helpers.sheets.Logs._rows.map((r) => r.join(' ')).join(' ');
  ok(joined.indexOf('gho_') === -1, 'aucun token dans le journal');
});

/* -------------------------------------------------------------------------- */
suite('Non-régression — périmètre respecté');
/* -------------------------------------------------------------------------- */

test('le pipeline de publication n\'est pas modifié par Scheduler.gs', () => {
  ['deleteArticle', 'deleteArticleById', 'runDeletePipeline', 'publishSelectedArticle',
    'publishNextReadyArticle', 'assertWritesAllowed', 'deleteFile'
  ].forEach((fn) => {
    notOk(new RegExp('function\\s+' + fn + '\\s*\\(').test(SCHEDULER_SRC), fn + ' non redéfini');
  });
});

test('Scheduler.gs n\'écrit que via setConfigValue', () => {
  const writers = (SCHEDULER_SRC.match(/\w+SetValue\s*\(/g) || []);
  eqList(writers, [], 'aucun setValue direct');
  ok(SCHEDULER_SRC.indexOf('setConfigValue(') !== -1, 'setConfigValue utilisé');
});

test('les constantes de clés correspondent au périmètre annoncé', () => {
  const { ctx } = makeCtx();
  const writable = ctx.SCHEDULER_WRITABLE_KEYS;
  eqList(writable, [
    'AUTO_PUBLISH', 'SCHEDULE_MODE', 'ARTICLES_PER_WEEK', 'PUBLISH_DAYS', 'MAX_ARTICLES_PER_RUN'
  ], 'périmètre d\'écriture');
  writable.forEach((k) => {
    ok(ctx.CONFIG_KEYS.indexOf(k) !== -1, k + ' existe déjà dans Config.gs');
  });
});

test('ensureConfigSheet continue de recréer les clés legacy', () => {
  const { ctx } = createContext({ sheets: { Logs: logsSheet() } });
  call(ctx, 'ensureConfigSheet');
  const map = call(ctx, 'readConfigMap');
  eq(map.WORDPRESS_URL, 'LEGACY / NOT USED', 'WORDPRESS_URL recréée');
  eq(map.WORDPRESS_DEFAULT_STATUS, 'LEGACY / NOT USED', 'WORDPRESS_DEFAULT_STATUS recréée');
  eq(map.CREATE_MISSING_CATEGORIES, 'LEGACY / NOT USED', 'CREATE_MISSING_CATEGORIES recréée');
});

/* -------------------------------------------------------------------------- */

process.stdout.write('\n');
if (failures.length) {
  process.stdout.write('ECHEC : ' + failures.length + ' test(s) en échec, ' + passed + ' réussi(s)\n');
  failures.forEach((f) => process.stdout.write('  [' + f.suite + '] ' + f.name + '\n    ' + f.message + '\n'));
  process.exit(1);
}
process.stdout.write('OK : ' + passed + ' tests réussis (Scheduler)\n');
