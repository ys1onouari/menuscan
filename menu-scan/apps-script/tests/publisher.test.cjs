/**
 * Menu Scan — Tests du moteur de publication (Publisher.gs)
 * ---------------------------------------------------------------------------
 * Exécution : `npm run test:apps-script`
 *
 * AUCUN réseau, AUCUNE écriture GitHub réelle, AUCUN vrai tableur : toutes les
 * réponses HTTP sont mockées route par route et toute route non déclarée fait
 * échouer le test. Le gabarit réel (`blog/template-article.html`) est lu tel
 * quel depuis le dépôt (D3) — aucune copie, aucune fixture.
 *
 * Ces tests prouvent le comportement OBSERVABLE :
 *   - la ligne sélectionnée / le prochain READY sont bien choisis ;
 *   - le verrou est acquired en tryLock et relâché même en cas d'échec ;
 *   - les transitions READY → PUBLISHING → PUBLISHED | ERROR sont observées ;
 *   - TEST_MODE et GITHUB_WRITE_ENABLED bloquent TOUTE écriture ;
 *   - 404 → create, fichier présent → update avec SHA, 409 → re-read + retry ;
 *   - 422 / 401 / 403 deviennent ERROR avec message, jamais PUBLISHED ;
 *   - 429 / 500 / 502 / 503 sont retentés (et seulement eux) ;
 *   - republier un contenu identique ne crée aucun nouveau commit.
 */

const fs = require('fs');
const path = require('path');

const {
  createContext,
  call,
  articlesSheet,
  configSheet,
  logsSheet,
  makeFetchMock,
  makeRepoMock,
  makeGitMock,
  contentsResponse,
  putResponse,
  articleListItem,
  indexPageFixture,
  blogHubFixture,
  articlesJsonFixture,
  sitemapFixture
} = require('./harness.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'public', 'blog', 'template-article.html');
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const BLOG_DIR = 'public/blog';
const TEMPLATE_ROUTE = '/contents/public/blog/template-article.html';
const ARTICLE_PATH = BLOG_DIR + '/fr/article-de-test.html';
const ARTICLE_ROUTE = '/contents/' + ARTICLE_PATH;
const TOKEN = 'ghp_test0000000000000000000000000000';

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

function includes(list, value, label) {
  if (list.indexOf(value) === -1) {
    throw new Error((label || 'liste') + ' : ' + JSON.stringify(value) +
      ' absent de ' + JSON.stringify(list));
  }
}

/** Comparaison structurelle : `eq` compare des références, pas des tableaux. */
function eqList(actual, expected, label) {
  eq(JSON.stringify(actual), JSON.stringify(expected), label);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeArticle(overrides) {
  return Object.assign({
    ID: 'A-1',
    TITLE: 'Facture TVA : le guide complet',
    KEYWORD: 'facturation',
    CONTENT:
      '<h2 id="alpha">Déclaration de TVA</h2>\n' +
      '<p>La TVA se déclare chaque mois, en sixteen lignes.</p>\n' +
      '<h2 id="beta">Erreurs fréquentes</h2>\n' +
      '<ul><li>Oublier le taux réduit</li><li>Confondre HT et TTC</li></ul>',
    CATEGORY: 'guides-prix',
    SLUG: 'article-de-test',
    LANG: 'fr',
    TRANSLATION_GROUP: 'article-de-test',
    SEO_TITLE: 'Facture TVA',
    META_DESCRIPTION: 'Tout sur la TVA facturée au Maroc : taux, déclaration, cas particuliers.',
    IMAGE_URL: '/blog/images/guides-prix.jpg',
    IMAGE_ALT: 'Illustration de l\'article sur la TVA',
    IMAGE_WIDTH: '1200',
    IMAGE_HEIGHT: '630',
    STATUS: 'READY',
    PUBLISHED_AT: '2026-07-14',
    SOCIAL_DESCRIPTION: 'Description sociale de test, distincte.',
    ARTICLE_EXCERPT: 'Extrait d’article distinct de la description.',
    CARD_EXCERPT: 'Texte de carte distinct.',
    READING_TIME: '6',
    ERROR: '',
    GITHUB_PATH: '',
    GITHUB_SHA: '',
    GITHUB_COMMIT: ''
  }, overrides || {});
}

/** Route GET du gabarit, réutilisée par tous les scénarios. */
function templateRoute(times) {
  return { method: 'get', path: TEMPLATE_ROUTE, body: contentsResponse('blog/template-article.html', TEMPLATE), times: times || 1 };
}

/* ------------------------------------------------------------------------ */
/* Fixtures des index statiques du Blog                                       */
/* ------------------------------------------------------------------------ */

const HUB_PATH = BLOG_DIR + '/index.html';
const ARTICLES_JSON = BLOG_DIR + '/articles.json';
const SITEMAP_FILE = 'public/sitemap.xml';
const SITE = 'https://menuscan.space';

/** Les 6 catégories réelles, dans l'ordre de la configuration. */
const CATEGORY_SLUGS = ['menu-digital', 'qr-code', 'restaurants-cafes', 'hotels-riads', 'commerces', 'guides-prix'];

/**
 * Chemin REPO d'un article : `/blog/{LANG}/{SLUG}.html`. La catégorie n'entre
 * PAS dans le chemin — elle ne sert qu'au tri de `articles.json`.
 */
function repoPathOf(article) {
  return BLOG_DIR + '/' + (article.LANG || 'fr') + '/' + article.SLUG;
}
function hrefOf(article) {
  return '/blog/' + (article.LANG || 'fr') + '/' + article.SLUG + '.html';
}

/** <loc> présents dans un sitemap. */
function sitemapLocs(xml) {
  return (String(xml).match(/<loc>[^<]*<\/loc>/g) || []).map((l) => l.replace(/<\/?loc>/g, ''));
}

const SUPPORTED_LANGS = ['fr', 'en', 'es', 'ar'];
const DEFAULT_LANG = 'fr';

/**
 * Miroir de `sitemapAlternatesFor()` : un lien par langue PUBLIÉE du groupe,
 * dans l'ordre de `APP.SUPPORTED_LANGS`, puis `x-default`.
 *
 * La fixture DOIT reproduire exactement ce que la production écrirait : une
 * fixture différente ferait voir une écriture d'index à chaque publication et
 * l'idempotence — le cœur de la réconciliation — ne serait plus testée.
 */
function groupAlternates(published, article) {
  const group = article.TRANSLATION_GROUP || article.SLUG;
  const links = {};
  published
    .filter((r) => String(r.TRANSLATION_GROUP || r.SLUG) === String(group))
    .forEach((r) => { links[r.LANG || 'fr'] = SITE + hrefOf(r); });

  const self = article.LANG || 'fr';
  links[self] = SITE + hrefOf(article);
  links['x-default'] = links[DEFAULT_LANG] || links[self];

  return SUPPORTED_LANGS
    .filter((code) => Object.prototype.hasOwnProperty.call(links, code))
    .map((code) => ({ lang: code, url: links[code] }))
    .concat([{ lang: 'x-default', url: links['x-default'] }]);
}

/** `articles.json` du dépôt mocké, lu après une écriture. */
function jsonArticles(fetchMock) {
  const raw = fetchMock.file(ARTICLES_JSON);
  return raw ? JSON.parse(raw).articles : null;
}

/**
 * PUT du FICHIER ARTICLE seul.
 *
 * Une publication réelle écrit TROIS fichiers : l'article, `articles.json` et
 * le sitemap. Compter « les PUT » sans distinguer l'article de ses index
 * donnerait un chiffre faux et, pire, masquerait une régression d'index.
 *
 * @param {Object} fetchMock
 * @param {string} [route] route Contents de l'article, ARTICLE_ROUTE par défaut
 */
function articlePuts(fetchMock, route) {
  const needle = route || ARTICLE_ROUTE;
  return fetchMock.calls.filter((c) => c.method === 'put' && c.path.indexOf(needle) !== -1);
}

/** PUT des INDEX (tout PUT qui n'est pas le fichier article). */
function indexPuts(fetchMock) {
  return fetchMock.calls.filter((c) => c.method === 'put' && c.path.indexOf(ARTICLE_ROUTE) === -1);
}

/**
 * Dépôt mocké « déjà réconcilié » : l'article sous test ET ses frères sont
 * présents dans `articles.json` et dans le sitemap. C'est l'état réel après
 * une publication réussie, donc l'état de départ normal.
 *
 * Architecture de production, donc STRICTEMENT :
 *   - AUCUN index de catégorie (le Blog n'en a pas : seul `index.html` existe) ;
 *   - un hub DYNAMIQUE (`<ul class="b-list" id="b-list">` vide) : il n'a aucune
 *     liste statique à réconcilier, `articles.json` est sa seule source ;
 *   - les articles sous `public/blog/{LANG}/{SLUG}.html`.
 *
 * Les FICHIERS articles sont eux aussi ensemencés, avec leur SHA : c'est ce qui
 * exerce réellement le contrat `createOrUpdate` (404 → create, 409 → retry).
 *
 * `includeArticle: false` reproduit un index EN RETARD (article absent de
 * `articles.json` et du sitemap). `omit: [chemin]` retire un fichier du dépôt.
 * `withFiles: true` ensemence les FICHIERS articles (avec leur SHA), ce qui
 * exerce le contrat `createOrUpdate` en mode update ; par défaut ils sont
 * absents, donc la publication passe par une création (404 → create).
 */
function indexRepo(articles, options) {
  const o = options || {};
  const list = (Array.isArray(articles) ? articles : [articles]).filter(Boolean);
  const omit = o.omit || [];

  const indexed = list.filter((a) => a.__seeded || o.includeArticle !== false);
  const files = [];

  files.push({
    path: ARTICLES_JSON,
    content: articlesJsonFixture(indexed.map((a) => ({
      title: a.TITLE,
      url: hrefOf(a),
      lang: a.LANG || 'fr',
      category: a.CATEGORY,
      excerpt: a.ARTICLE_EXCERPT,
      image: a.IMAGE_URL,
      imageAlt: a.IMAGE_ALT,
      imageWidth: Number(a.IMAGE_WIDTH),
      imageHeight: Number(a.IMAGE_HEIGHT),
      date: a.PUBLISHED_AT,
      readingTime: Number(a.READING_TIME),
      slug: a.SLUG,
      translationGroup: a.TRANSLATION_GROUP || a.SLUG
    })))
  });

  // Le hub `/blog/` est en `weekly` : c'est ce que `ensureBlogHubInSitemap()`
  // écrit, donc la fixture doit le dire sinon toute publication le réécrit.
  const entries = [
    { loc: SITE + '/', lastmod: '2026-07-01' },
    { loc: SITE + '/blog/', lastmod: '2026-07-01', changefreq: 'weekly' }
  ];
  indexed.forEach((a) => entries.push({
    loc: SITE + hrefOf(a),
    lastmod: a.PUBLISHED_AT,
    alternates: groupAlternates(indexed, a)
  }));
  files.push({ path: SITEMAP_FILE, content: sitemapFixture(entries) });
  files.push({ path: HUB_PATH, content: blogHubFixture() });
  if (o.withFiles) {
    indexed.forEach((a) => {
      files.push({
        path: repoPathOf(a) + '.html',
        content: '<html>' + a.TITLE + '</html>',
        sha: a.GITHUB_SHA || 'sha-seed-' + a.SLUG
      });
    });
  }

  return files.filter((f) => omit.indexOf(f.path) === -1);
}

/**
 * Copie l'état courant du dépôt mocké, pour rejouer une publication dans un
 * contexte neuf qui repart de l'état réellement atteint.
 */
function repoSnapshot(fetchMock) {
  return INDEX_FILES.map((p) => ({ path: p, content: fetchMock.file(p) })).filter((f) => f.content !== null);
}

const INDEX_FILES = [HUB_PATH, ARTICLES_JSON, SITEMAP_FILE];

/**
 * Construit un contexte complet.
 *
 * Le dépôt mocké sert les 3 fichiers d'index (hub, `articles.json`, sitemap)
 * dans un état DÉJÀ réconcilié : la réconciliation ne doit donc produire aucune
 * écriture dans les scénarios historiques. `indexes: false` retire ces routes
 * (utile pour observer un refus réseau sur les index) et
 * `indexes: { includeArticle: false }` simule un index en retard.
 *
 * @param {{articles?:Array, config?:Object, props?:Object, routes?:Array,
 *          lockAvailable?:boolean, activeCell?:Object, sheets?:Object,
 *          indexes?:boolean|Object, indexFiles?:Array, fetchOptions?:Object}} [opt]
 */
function setup(opt) {
  const o = opt || {};
  const articles = o.articles || [makeArticle()];
  const repoOptions = o.indexes === undefined ? {} : o.indexes;
  const withIndexes = o.indexes !== false;

  const baseFetch = makeFetchMock(o.routes || [templateRoute()]);
  const files = o.indexFiles || indexRepo(articles, repoOptions);
  const fetchMock = withIndexes
    ? makeGitMock(files, o.routes || [templateRoute()],
      Object.assign({ missingAs404: true }, o.fetchOptions || {}))
    : baseFetch;

  const sheets = o.sheets === null ? {} : Object.assign({
    Articles: articlesSheet(articles),
    Logs: logsSheet()
  }, o.config === null ? {} : { Config: configSheet(o.config === undefined ? { TEST_MODE: 'FALSE' } : o.config) },
    o.sheets || {});

  const props = Object.assign({
    GITHUB_TOKEN: TOKEN,
    GITHUB_OWNER: 'menu-scan',
    GITHUB_REPOSITORY: 'site',
    GITHUB_BRANCH: 'master',
    GITHUB_WRITE_ENABLED: 'TRUE'
  }, o.props || {});

  const created = createContext({
    sheets: sheets,
    properties: props,
    fetchImpl: fetchMock,
    lockAvailable: o.lockAvailable,
    activeCell: o.activeCell
  });

  return {
    ctx: created.ctx,
    sheets: created.helpers.sheets,
    props: created.helpers.props,
    lock: created.helpers.lock,
    sleeps: created.helpers.sleeps,
    ui: created.helpers.ui,
    fetch: fetchMock,
    base: baseFetch
  };
}

/** Ligne `Articles` lue depuis la feuille (état réel, pas la fixture). */
function row(ctx, id) {
  return call(ctx, 'findArticleById', id);
}

function status(ctx, id) {
  return row(ctx, id).STATUS;
}

function logRows(sheets) {
  return sheets.Logs._rows;
}

function logMessages(sheets) {
  return logRows(sheets).map((r) => r[7]);
}

/* ========================================================================== */
suite('Sélection');
/* ========================================================================== */

test('la ligne sélectionnée est publiée (nominal)', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-new', 'commit-new'), times: Infinity }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat : ' + JSON.stringify(result.code) + ' ' + result.message);
  eq(result.code, 'PUBLISHED', 'code');
  eq(result.status, 'PUBLISHED', 'statut final');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'statut en feuille');
  eq(row(s.ctx, 'A-1').GITHUB_PATH, ARTICLE_PATH, 'GITHUB_PATH');
  eq(row(s.ctx, 'A-1').GITHUB_SHA, 'sha-new', 'GITHUB_SHA');
  eq(row(s.ctx, 'A-1').GITHUB_COMMIT, 'commit-new', 'GITHUB_COMMIT');
  eq(row(s.ctx, 'A-1').ERROR, '', 'ERROR vidé');
  eq(row(s.ctx, 'A-1').PUBLISHED_AT, '2026-07-14', 'PUBLISHED_AT préservé');
});

test('ligne sélectionnée vide : aucune action, aucun write', () => {
  const s = setup({ activeCell: { row: 1 }, routes: [] });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'NO_SELECTION', 'code');
  eq(status(s.ctx, 'A-1'), 'READY', 'statut inchangé');
  eq(s.fetch.calls.length, 0, 'aucun appel HTTP');
  eq(s.lock.log.length, 0, 'aucun verrou tentative');
});

test('ligne sélectionnée sans ligne Articles : refus explicite', () => {
  const s = setup({ activeCell: { row: 2 }, routes: [], sheets: { Articles: null } });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'NO_SELECTION', 'code');
  eq(s.fetch.calls.length, 0, 'aucun appel HTTP');
});

test('le prochain READY est choisi, pas les autres', () => {
  const s = setup({
    articles: [
      makeArticle({ ID: 'A-1', STATUS: 'DRAFT', SLUG: 'premier' }),
      makeArticle({ ID: 'A-2', STATUS: 'READY', SLUG: 'deuxieme' }),
      makeArticle({ ID: 'A-3', STATUS: 'READY', SLUG: 'troisieme' })
    ],
    routes: [
      templateRoute(),
      { method: 'get', path: '/contents/' + BLOG_DIR + '/fr/deuxieme.html', code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: '/contents/' + BLOG_DIR + '/fr/deuxieme.html', body: putResponse(BLOG_DIR + '/fr/deuxieme.html', 'x', 's', 'c'), times: Infinity }
    ]
  });
  const result = call(s.ctx, 'publishNextReadyArticle');
  ok(result.ok, 'résultat : ' + result.message);
  eq(result.articleId, 'A-2', 'article traité');
  eq(result.remaining, 1, 'READY restants signalés');
  eq(status(s.ctx, 'A-1'), 'DRAFT', 'A-1 non traité');
  eq(status(s.ctx, 'A-3'), 'READY', 'A-3 non traité');
  const puts = articlePuts(s.fetch, '/contents/' + BLOG_DIR + '/fr/deuxieme.html');
  eq(puts.length, 1, 'un seul PUT article');
  includes(puts[0].path, 'blog/fr/deuxieme.html', 'le PUT porte sur le BON article');
});

test('aucun READY : refus sans write', () => {
  const s = setup({ articles: [makeArticle({ STATUS: 'PUBLISHED' })], routes: [] });
  const result = call(s.ctx, 'publishNextReadyArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'NO_READY', 'code');
  eq(s.fetch.calls.length, 0, 'aucun appel HTTP');
});

/* ========================================================================== */
suite('Verrou');
/* ========================================================================== */

test('verrou déjà pris : refus immédiat, aucun write, statut intact', () => {
  const s = setup({
    lockAvailable: false,
    activeCell: { row: 2 },
    routes: []
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'LOCKED', 'code');
  includes(s.lock.log, 'tryLock:1000', 'verrou tenté en tryLock');
  eq(s.fetch.calls.length, 0, 'aucun appel HTTP');
  eq(status(s.ctx, 'A-1'), 'READY', 'statut inchangé');
});

test('le verrou est relâché après un succès', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 's', 'c') }
    ]
  });
  call(s.ctx, 'publishSelectedArticle');
  includes(s.lock.log, 'releaseLock', 'verrou relâché');
  notOk(s.lock.held, 'verrou libéré');
});

test('le verrou est relâché même après un échec GitHub', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 422, body: { message: 'Invalid request' } }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  includes(s.lock.log, 'releaseLock', 'verrou relâché');
  notOk(s.lock.held, 'verrou libéré');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut ERROR');
});

/* ========================================================================== */
suite('Transitions refusées');
/* ========================================================================== */

['PUBLISHED', 'PUBLISHING', 'ERROR'].forEach((st) => {
  test('statut ' + st + ' : republication refusée sans write', () => {
    const s = setup({
      articles: [makeArticle({ STATUS: st })],
      activeCell: { row: 2 },
      routes: []
    });
    const result = call(s.ctx, 'publishSelectedArticle');
    notOk(result.ok, 'résultat');
    eq(result.code, 'REPUBLISH_BLOCKED', 'code');
    eq(status(s.ctx, 'A-1'), st, 'statut inchangé');
    eq(s.fetch.calls.length, 0, 'aucun appel HTTP');
  });
});

/* ========================================================================== */
suite('Rendu et validation');
/* ========================================================================== */

test('gabarit introuvable : ERROR + message, aucun write', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [{ method: 'get', path: TEMPLATE_ROUTE, code: 404, body: { message: 'Not Found' } }]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'TEMPLATE', 'code');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut');
  ok(row(s.ctx, 'A-1').ERROR.length > 0, 'ERROR renseigné');
  eq(s.fetch.calls.length, 1, 'un seul appel (lecture gabarit)');
});

test('rendu en échec : ERROR + codes du moteur', () => {
  const s = setup({
    articles: [makeArticle({ CONTENT: '' })],
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'RENDER', 'code');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut');
  includes(row(s.ctx, 'A-1').ERROR, 'V5', 'code V5 (CONTENT) reported');
  eq(s.fetch.calls.length, 1, 'aucun write tenté');
});

test('validation de production : un lien mort dans le corps bloque la publication', () => {
  const s = setup({
    articles: [makeArticle({ CONTENT: '<h2 id="alpha">A</h2><a href="#fantome">lien mort</a>' })],
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'RENDER', 'code');
  includes(row(s.ctx, 'A-1').ERROR, 'V9', 'code V9 (ancre morte) reported');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut');
});

test('catégorie inconnue : ERROR avant tout accès GitHub du fichier', () => {
  const s = setup({
    articles: [makeArticle({ CATEGORY: 'Rubrique Fantôme' })],
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'RENDER', 'code');
  includes(row(s.ctx, 'A-1').ERROR, 'V3', 'code V3 (catégorie) reported');
});

test('READING_TIME absent : ERROR (le temps de lecture est éditorial, jamais calculé)', () => {
  const s = setup({
    articles: [makeArticle({ READING_TIME: '' })],
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'RENDER', 'code');
  includes(row(s.ctx, 'A-1').ERROR, 'V19', 'code V19 (temps de lecture)');
  eq(s.fetch.calls.length, 1, 'aucune écriture');
});

test('PUBLISHED_AT vide : la date du jour est posée au format attendu par le moteur', () => {
  const s = setup({
    articles: [makeArticle({ PUBLISHED_AT: '' })],
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 's', 'c') }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat : ' + result.message);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(row(s.ctx, 'A-1').PUBLISHED_AT),
    'PUBLISHED_AT au format YYYY-MM-DD, obtenu ' + row(s.ctx, 'A-1').PUBLISHED_AT);
});

test('le pipeline passe par PUBLISHING (transition observée)', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 's', 'c') }
    ]
  });
  const seen = [];
  const original = s.ctx.updateArticleFields;
  s.ctx.updateArticleFields = function (id, fields) {
    seen.push(id + ':' + fields.STATUS);
    return original.call(s.ctx, id, fields);
  };
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat');
  eq(seen[0], 'A-1:PUBLISHING', 'première transition');
  eq(seen[seen.length - 1], 'A-1:PUBLISHED', 'transition finale');
});

/* ========================================================================== */
suite('Verrous d\'écriture');
/* ========================================================================== */

test('TEST_MODE=TRUE : rendu et validation exécutés, AUCUNE écriture', () => {
  const s = setup({
    config: { TEST_MODE: 'TRUE' },
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'TEST_MODE', 'code');
  ok(result.testMode, 'indicateur mode test');
  ok(result.validation && result.validation.ok, 'la validation de production a bien tourné');
  eq(s.fetch.calls.length, 1, 'seule la lecture du gabarit');
  eq(status(s.ctx, 'A-1'), 'READY', 'statut restauré (publiable)');
  eq(row(s.ctx, 'A-1').ERROR, '', 'ERROR vide');
});

test('GITHUB_WRITE_ENABLED=FALSE : refus, aucun write', () => {
  const s = setup({
    props: { GITHUB_WRITE_ENABLED: 'FALSE' },
    config: { TEST_MODE: 'FALSE' },
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'WRITES_DISABLED', 'code');
  eq(s.fetch.calls.length, 1, 'aucun write');
  eq(status(s.ctx, 'A-1'), 'READY', 'statut restauré');
});

test('Config absente : refus fermé (fail closed)', () => {
  const s = setup({
    config: null,
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  notOk(s.sheets.Config, 'aucune feuille Config');
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'GATE', 'code');
  eq(s.fetch.calls.length, 1, 'aucun write');
  eq(status(s.ctx, 'A-1'), 'READY', 'statut restauré');
});

test('TEST_MODE reste TRUE après une publication refusée', () => {
  const s = setup({
    config: { TEST_MODE: 'TRUE' },
    activeCell: { row: 2 },
    routes: [templateRoute()]
  });
  call(s.ctx, 'publishSelectedArticle');
  eq(call(s.ctx, 'getConfigBoolean', 'TEST_MODE'), true, 'TEST_MODE inchangé');
  eq(call(s.ctx, 'writesEnabled'), true, 'le verrou d\'écriture n\'a pas été touché');
});

/* ========================================================================== */
suite('Contents API');
/* ========================================================================== */

test('404 sur la cible : création avec message de commit déterministe', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-create', 'commit-create') }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat : ' + result.message);

  const put = s.fetch.calls.filter((c) => c.method === 'put')[0];
  ok(put, 'PUT émis');
  const payload = JSON.parse(put.payload);
  eq(payload.message, 'Publication : article-de-test', 'message de commit');
  notOk('sha' in payload, 'aucun SHA sur une création');
  const decoded = Buffer.from(payload.content, 'base64').toString('utf8');
  includes(decoded, 'index, follow', 'robots basculés en production');
  includes(decoded, 'Facture TVA', 'titre injecté');
  notOk(decoded.indexOf('{{') !== -1, 'aucun placeholder résiduel');
  eq(result.githubCommit, 'commit-create', 'commit tracé');
});

test('fichier déjà présent : mise à jour avec le SHA distant', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, body: contentsResponse(ARTICLE_PATH, 'ancien contenu', 'sha-ancien') },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-nouveau', 'commit-update') }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat : ' + result.message);
  const put = s.fetch.calls.filter((c) => c.method === 'put')[0];
  const payload = JSON.parse(put.payload);
  eq(payload.sha, 'sha-ancien', 'SHA envoyé pour l\'update');
  eq(result.githubSha, 'sha-nouveau', 'SHA retourné conservé');
  eq(row(s.ctx, 'A-1').GITHUB_SHA, 'sha-nouveau', 'GITHUB_SHA en feuille');
});

test('409 : relecture du SHA puis retry borné', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, body: contentsResponse(ARTICLE_PATH, 'v1', 'sha-v1') },
      { method: 'put', path: ARTICLE_ROUTE, code: 409, body: { message: 'is at ... but expected ...' } },
      { method: 'get', path: ARTICLE_ROUTE, body: contentsResponse(ARTICLE_PATH, 'v2', 'sha-v2') },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-v3', 'commit-v3') }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat : ' + result.message);
  const puts = articlePuts(s.fetch);
  eq(puts.length, 2, 'deux PUT article (conflit + retry)');
  eq(JSON.parse(puts[0].payload).sha, 'sha-v1', '1er PUT : SHA initial');
  eq(JSON.parse(puts[1].payload).sha, 'sha-v2', '2e PUT : SHA relu');
  eq(result.githubSha, 'sha-v3', 'SHA final');
  ok(result.retried, 'retry signalé dans le résultat');
});

test('422 : ERROR avec message, jamais PUBLISHED', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 422, body: { message: 'Invalid request' } }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'GITHUB', 'code');
  eq(result.status, 'ERROR', 'statut retourné');
  includes(row(s.ctx, 'A-1').ERROR, '422', 'code HTTP dans le message');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut en feuille');
  eq(row(s.ctx, 'A-1').GITHUB_SHA, '', 'aucun SHA inventé');
});

test('401 : refus explicite token absent ou expiré', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 401, body: { message: 'Bad credentials' } }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  includes(row(s.ctx, 'A-1').ERROR, '401', 'code HTTP');
  includes(row(s.ctx, 'A-1').ERROR, 'token', 'cause.token évoquée');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut');
});

test('403 : permission insuffisante refusée', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 403, body: { message: 'Forbidden' } }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  includes(row(s.ctx, 'A-1').ERROR, '403', 'code HTTP');
});

test('le token n\'apparaît jamais dans les journaux', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 's', 'c') }
    ]
  });
  call(s.ctx, 'publishSelectedArticle');
  const dump = JSON.stringify(logRows(s.sheets));
  notOk(dump.indexOf(TOKEN) !== -1, 'token absent des logs');
});

test('un token glissé dans une erreur GitHub est expurgé avant écriture en feuille', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 422, body: { message: 'clé ' + TOKEN + ' rejetée' } }
    ]
  });
  call(s.ctx, 'publishSelectedArticle');
  notOk(row(s.ctx, 'A-1').ERROR.indexOf(TOKEN) !== -1, 'token expurgé de la colonne ERROR');
  notOk(JSON.stringify(logRows(s.sheets)).indexOf(TOKEN) !== -1, 'token expurgé des logs');
});

test('assertWritesAllowed reste le point d\'entrée unique : appel direct refusé en mode test', () => {
  const s = setup({ config: { TEST_MODE: 'TRUE' }, routes: [] });
  let thrown = null;
  try {
    call(s.ctx, 'createOrUpdateFile', { path: ARTICLE_PATH, content: 'x', message: 'contournement' });
  } catch (e) {
    thrown = e;
  }
  ok(thrown, 'createOrUpdateFile refuse l\'écriture');
  eq(thrown.message, 'TEST_MODE=TRUE : aucune écriture GitHub n\'est effectuée.', 'message du verrou');
  eq(s.fetch.calls.length, 0, 'aucun appel HTTP, le verrou tranche avant');
});

/* ========================================================================== */
suite('Retries');
/* ========================================================================== */

[429, 500, 502, 503].forEach((code) => {
  test('HTTP ' + code + ' : retenté puis publication réussie', () => {
    const s = setup({
      config: { TEST_MODE: 'FALSE', MAX_RETRIES: '3' },
      activeCell: { row: 2 },
      routes: [
        templateRoute(),
        { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
        { method: 'put', path: ARTICLE_ROUTE, code: code, body: { message: 'transitoire' } },
        { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-ok', 'commit-ok') }
      ]
    });
    const result = call(s.ctx, 'publishSelectedArticle');
    ok(result.ok, 'résultat : ' + result.message);
    eq(articlePuts(s.fetch).length, 2, 'PUT article retenté une fois');
    ok(s.sleeps.length > 0, 'attente entre les tentatives');
  });
});

test('retries épuisés : la réponse est rendue à l\'appelant', () => {
  const s = setup({
    config: { TEST_MODE: 'FALSE', MAX_RETRIES: '1' },
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 503, body: { message: 'Service unavailable' }, times: Infinity }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'GITHUB', 'code');
  includes(row(s.ctx, 'A-1').ERROR, '503', 'code HTTP final');
  eq(articlePuts(s.fetch).length, 2, '1 tentative + 1 retry');
});

test('422 n\'est jamais retenté (échec permanent)', () => {
  const s = setup({
    config: { TEST_MODE: 'FALSE', MAX_RETRIES: '3' },
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, code: 422, body: { message: 'Invalid request' }, times: Infinity }
    ]
  });
  call(s.ctx, 'publishSelectedArticle');
  eq(articlePuts(s.fetch).length, 1, 'un seul PUT article');
});

/* ========================================================================== */
suite('Idempotence');
/* ========================================================================== */

/** Rend le HTML exact produit par une publication (via la charge utile PUT). */
function publishedHtml(s) {
  const put = s.fetch.calls.filter((c) => c.method === 'put')[0];
  return Buffer.from(JSON.parse(put.payload).content, 'base64').toString('utf8');
}

const WRITE_ROUTES = [
  templateRoute(),
  { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
  { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-first', 'commit-first') }
];

test('republier un contenu identique ne crée aucun nouveau commit', () => {
  const first = setup({ activeCell: { row: 2 }, routes: WRITE_ROUTES });
  const r1 = call(first.ctx, 'publishSelectedArticle');
  ok(r1.ok, 'première publication : ' + r1.message);
  const html = publishedHtml(first);

  // L'opérateur repasse la ligne en READY, comme documenté.
  call(first.ctx, 'updateArticleFields', 'A-1', { STATUS: 'READY' });

  const second = setup({
    activeCell: { row: 2 },
    articles: [makeArticle({ STATUS: 'READY', GITHUB_PATH: ARTICLE_PATH, GITHUB_SHA: 'sha-first', GITHUB_COMMIT: 'commit-first' })],
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, body: contentsResponse(ARTICLE_PATH, html, 'sha-first'), times: Infinity }
    ]
  });
  const r2 = call(second.ctx, 'publishSelectedArticle');
  ok(r2.ok, 'deuxième publication : ' + r2.message);
  eq(r2.code, 'UNCHANGED', 'code');
  eq(articlePuts(second.fetch).length, 0, 'aucun PUT article');
  eq(indexPuts(second.fetch).length, 0, 'aucun PUT d\'index non plus');
  eq(r2.githubSha, 'sha-first', 'SHA distant réutilisé');
  eq(status(second.ctx, 'A-1'), 'PUBLISHED', 'statut PUBLISHED');
  eq(row(second.ctx, 'A-1').GITHUB_COMMIT, 'commit-first', 'commit historique préservé');
});

test('un contenu différent déclenche bien un nouvel update', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, body: contentsResponse(ARTICLE_PATH, 'contenu différent', 'sha-v1') },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-v2', 'commit-v2') }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat');
  eq(result.code, 'PUBLISHED', 'code');
  eq(articlePuts(s.fetch).length, 1, 'un PUT article émis');
});

test('deux exécutions en mode test ne produisent aucun write', () => {
  const s = setup({
    config: { TEST_MODE: 'TRUE' },
    activeCell: { row: 2 },
    routes: [templateRoute(2)]
  });
  call(s.ctx, 'publishSelectedArticle');
  const r2 = call(s.ctx, 'publishSelectedArticle');
  eq(r2.code, 'TEST_MODE', 'deuxième passage toujours refusé');
  eq(s.fetch.calls.length, 2, 'seules les deux lectures du gabarit');
  eq(status(s.ctx, 'A-1'), 'READY', 'statut toujours publiable');
});

/* ========================================================================== */
suite('Intégrité et menu');
/* ========================================================================== */

test('TEST_MODE est TRUE par défaut dans la configuration', () => {
  eq(call(createContext({}).ctx, 'getConfigBoolean', 'TEST_MODE'), true, 'défaut sûr');
});

test('les deux entrées de publication sont au menu, après la validation', () => {
  const s = setup();
  call(s.ctx, 'onOpen');
  const labels = s.ui.items.map((i) => i.label);
  const iValidate = labels.indexOf('✅ Valider les articles');
  const iSelected = labels.indexOf('🚀 Publier l\'article sélectionné');
  const iNext = labels.indexOf('🚀 Publier le prochain article READY');
  ok(iSelected !== -1, 'entrée « article sélectionné » présente');
  ok(iNext !== -1, 'entrée « prochain READY » présente');
  ok(iValidate < iSelected && iSelected < iNext, 'ordre : validation, sélectionné, prochain');
  eq(s.ui.items[iSelected].fn, 'publishSelectedArticle', 'callback');
  eq(s.ui.items[iNext].fn, 'publishNextReadyArticle', 'callback');
});

test('aucune entrée de scheduler ni de publication par lot', () => {
  const s = setup();
  call(s.ctx, 'onOpen');
  const items = s.ui.items.filter((i) => i.fn);

  // Un MOTEUR de planification reste interdit : aucune entree de menu, hormis
  // le dialogue de configuration, ne doit pointer vers un scheduler, une
  // publication par lot, une activation automatique ou un declencheur.
  const CONFIG_DIALOG = 'openSchedulerConfigDialog';
  items.forEach((i) => {
    if (i.fn === CONFIG_DIALOG) return;
    notOk(
      /schedul|cron|autopubl|batch|runall|publishtall|trigger/i.test(i.fn),
      'aucun moteur dans ' + i.fn
    );
  });

  // Seule entree de planification admise : le dialogue de CONFIGURATION
  // valide par le Product Owner, qui ne cree aucun declencheur (prouve
  // par scheduler.test.cjs : ScriptApp reste vide).
  const planning = items.filter((i) => /planifi|schedul|cron/i.test(i.label + ' ' + i.fn));
  eq(planning.length, 1, 'une seule entree de planification');
  eq(planning[0].fn, CONFIG_DIALOG, 'dialogue de configuration');
});

test('les actions de menu historiques restent câblées', () => {
  const s = setup();
  call(s.ctx, 'onOpen');
  const fns = s.ui.items.map((i) => i.fn).filter(Boolean);
  ['menuConfiguration', 'menuBootstrapSheets', 'menuTestGithub', 'menuCheckTemplate',
    'menuValidateArticles', 'publishSelectedArticle', 'publishNextReadyArticle',
    'menuShowErrors'].forEach((fn) => {
    includes(fns, fn, 'entrée ' + fn);
  });
});

test('une route HTTP non mockée n\'est jamais contournée par un appel réel', () => {
  const s = setup({ activeCell: { row: 2 }, indexes: false, routes: [templateRoute(1)] });
  // Seule la lecture du gabarit est mockée : toute autre route fait échouer le
  // mock, ce qui devient une erreur de transport pour httpRequest. Le
  // Publisher doit alors reporter l'article en ERROR, sans rien publier.
  const result = call(s.ctx, 'publishSelectedArticle');
  notOk(result.ok, 'résultat');
  eq(result.code, 'GITHUB', 'la lecture de la cible échoue');
  includes(row(s.ctx, 'A-1').ERROR, 'Transport', 'erreur de transport remontée');
  eq(status(s.ctx, 'A-1'), 'ERROR', 'statut');
  eq(s.fetch.calls.filter((c) => c.method === 'put').length, 0, 'aucun PUT du tout');
  ok(s.fetch.calls.length > 2, 'le mock a bien intercepté la route absente : ' + s.fetch.calls.length + ' appels');
});

test('le compte rendu opérateur reste lisible et sans secret', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-x', 'commit-x') }
    ]
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  const report = call(s.ctx, 'formatPublishReport', result);
  includes(report, 'RÉUSSIE', 'en-tête');
  includes(report, ARTICLE_PATH, 'chemin du fichier');
  includes(report, SITE + hrefOf(makeArticle()), 'URL publique');
  notOk(report.indexOf(TOKEN) !== -1, 'aucun token dans le compte rendu');
  eq(s.ui.alerts.length, 1, 'une alerte émise');
});

test('les logs de publication sont structurés', () => {
  const s = setup({
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: ARTICLE_ROUTE, body: putResponse(ARTICLE_PATH, 'x', 'sha-x', 'commit-x') }
    ]
  });
  call(s.ctx, 'publishSelectedArticle');
  const actions = logRows(s.sheets).map((r) => r[2]);
  includes(actions, 'publish', 'action publish journalisée');
  const success = logRows(s.sheets).filter((r) => r[1] === 'SUCCESS');
  ok(success.length >= 1, 'un niveau SUCCESS');
  ok(logMessages(s.sheets).length >= 1, 'messages présents');
});

/* ========================================================================== */
/* REGRESSION — « html.replace is not a function » (TEST-001)                  */
/* ========================================================================== */

suite('Régression TEST-001 (html.replace)');

/**
 * Cause racine : decodeContentResponse() livrait le retour brut de
 * Utilities.base64Decode(), qui est un Byte[] (tableau d'octets signes) et non
 * une String. validateTemplate() Receiving alors un tableau :
 *   - html.length          -> longueur en OCTETS  (faux, silencieux)
 *   - html.indexOf('{{…}}')-> Array#indexOf       -> -1, erreur T2 pushed
 *   - html.replace(...)    -> TypeError            -> plantage
 * D'ou l'erreur observee en TEST_MODE, avant tout appel en ecriture.
 */
test('cause racine : getFile().content est une String, pas un Byte[]', () => {
  const s = setup({ routes: [templateRoute()] });

  const file = call(s.ctx, 'getFile', 'public/blog/template-article.html');
  ok(file, 'fichier décodé');
  eq(typeof file.content, 'string', 'type de content');
  notOk(Array.isArray(file.content), 'ce n’est pas un tableau d’octets');
  eq(file.content, TEMPLATE, 'contenu intégralement restitué (UTF-8 exact)');
  eq(file.content.length, TEMPLATE.length, 'longueur en caractères (pas en octets)');
  includes(file.content, '{{TITLE}}', 'gabarit lisible comme du texte');
});

test('cause racine : l’UTF-8 survive au passage base64 (accents + arabe)', () => {
  const source = '<p>Facture conforme : é, è, ù, ç —，拿着发票</p>';
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const s = setup({ routes: [templateRoute()] });

  // Réponse shaped comme celle de l'API Contents : base64 découpé par \n.
  const decoded = call(s.ctx, 'decodeContentResponse', {
    type: 'file',
    sha: 'sha-utf8',
    path: 'blog/x.html',
    size: Buffer.byteLength(source, 'utf8'),
    content: encoded.replace(/(.{20})/g, '$1\n')
  });

  eq(typeof decoded.content, 'string', 'type de content');
  eq(decoded.content, source, 'UTF-8 fidèle (aucun octet signé résiduel)');
  eq(decoded.content.length, source.length, 'longueur en caractères');
});

test('cause racine : validateTemplate() reçoit bien une String', () => {
  const s = setup({ routes: [templateRoute()] });
  const content = call(s.ctx, 'getFile', 'public/blog/template-article.html').content;

  // Point exact du plantage historique (Validator.gs, validateTemplate).
  const validation = call(s.ctx, 'validateTemplate', content);
  ok(validation.ok, 'gabarit valide : ' + JSON.stringify(validation.errors));
  notOk(
    validation.errors.some((e) => String(e.message).indexOf('html.replace') !== -1),
    'aucune trace de l’erreur de type'
  );
});

test('TEST-001 complet : READY + TEST_MODE, rendu et validation OK, 0 write', () => {
  const s = setup({
    articles: [makeArticle({
      ID: 'TEST-001',
      TITLE: 'Comment créer une facture conforme au Maroc',
      CATEGORY: 'guides-prix',
      SLUG: 'test-facture-conforme-maroc',
      STATUS: 'READY',
      PUBLISHED_AT: ''
    })],
    // TEST_MODE seul bloque : GITHUB_WRITE_ENABLED reste TRUE, ce qui prouve
    // que le verrou produit le refus (et non unsettings manquant).
    config: { TEST_MODE: 'TRUE' },
    activeCell: { row: 2 },
    // 2 lectures du gabarit : la sonde directe ci-dessus, puis le Publisher.
    routes: [templateRoute(2)]
  });

  // 1. le Publisher reçoit bien la ligne
  const line = row(s.ctx, 'TEST-001');
  eq(line.SLUG, 'test-facture-conforme-maroc', 'slug de la ligne');
  eq(line.CATEGORY, 'guides-prix', 'catégorie de la ligne');
  eq(line.STATUS, 'READY', 'statut de départ');

  // 2-5. rendu + post-traitement + validation, sans l'erreur de type.
  // Le rapport de refus n'expose volontairement PAS le HTML ; on prouve donc la
  // String à la source (renderArticleHtml) et via validation.ok, qui ne peut
  // aboutir que si le post-traitement a reçu du texte.
  //
  // R0 refuse une ligne READY : le moteur ne rend que ce qui est PUBLIÉ (le
  // Publisher bascule d'abord en PUBLISHING). On le prouve, puis on rend dans
  // l'état que le Publisher prépare réellement.
  const templateHtml = call(s.ctx, 'getFile', 'public/blog/template-article.html').content;
  const refused = call(s.ctx, 'renderArticleHtml', line, { templateHtml: templateHtml });
  notOk(refused.ok, 'R0 refuse une ligne READY');
  includes(JSON.stringify(refused.errors), 'R0', 'code R0 (statut)');

  const render = call(s.ctx, 'renderArticleHtml', Object.assign({}, line, { STATUS: 'PUBLISHING' }), {
    templateHtml: templateHtml,
    publishedAt: '2026-09-30'
  });
  ok(render.ok, 'rendu réussi : ' + JSON.stringify(render.errors));
  eq(typeof render.html, 'string', 'renderArticleHtml renvoie une String');
  notOk(Array.isArray(render.html), 'le HTML rendu n’est pas un tableau');
  ok(render.html.indexOf('Comment créer une facture conforme au Maroc') !== -1, 'titre injecté');
  ok(call(s.ctx, 'validateRenderedHtml', render.html, {
    canonicalPath: '/blog/fr/test-facture-conforme-maroc.html'
  }).ok, 'validateRenderedHtml accepte le rendu');

  // On ne compte que les appels du Publisher (la sonde ci-dessus en fait 1).
  const callsBefore = s.fetch.calls.length;
  const result = call(s.ctx, 'publishSelectedArticle');
  const publishCalls = s.fetch.calls.slice(callsBefore);
  notOk(String(result.message).indexOf('html.replace') !== -1, 'aucun « html.replace is not a function »');
  notOk(String(result.error || '').indexOf('html.replace') !== -1, 'aucune trace dans error');
  notOk(String(result.detail || '').indexOf('html.replace') !== -1, 'aucune trace dans detail');
  eq(result.code, 'TEST_MODE', 'refus attendu : mode test');
  ok(result.testMode, 'indicateur mode test');
  ok(result.validation && result.validation.ok, 'validation de production réussie');

  // 6. aucune écriture GitHub
  eq(publishCalls.filter((c) => c.method !== 'get').length, 0, '0 write (0 PUT/POST/PATCH/DELETE)');
  eq(s.fetch.calls.filter((c) => c.method !== 'get').length, 0, '0 write sur la session entière');
  eq(publishCalls.length, 1, 'le Publisher n’a fait qu’une requête');
  ok(publishCalls[0].path.indexOf(TEMPLATE_ROUTE) !== -1, 'l’unique appel est le GET du gabarit');
  ok(publishCalls[0].path.indexOf('?ref=master') !== -1, 'lecture sur la branche master');
  ok(s.fetch.calls[0].path.indexOf(TEMPLATE_ROUTE) !== -1, 'la sonde a lu le même gabarit');

  // 7. aucun appel réel : toute route non mockée lève
  eq(s.fetch.calls.every((c) => c.path.indexOf('/repos/') === 0), true, 'appels limités à l’API mockée');

  // État conservé : la ligne reste publiable
  eq(status(s.ctx, 'TEST-001'), 'READY', 'statut restauré (READY, comme le contrat le prévoit)');
  eq(row(s.ctx, 'TEST-001').ERROR, '', 'ERROR vide');
  eq(row(s.ctx, 'TEST-001').GITHUB_PATH, '', 'GITHUB_PATH vide');
});

test('TEST-001 : deux simulations successives restent à 0 write', () => {
  const s = setup({
    articles: [makeArticle({
      ID: 'TEST-001',
      CATEGORY: 'guides-prix',
      SLUG: 'test-facture-conforme-maroc',
      STATUS: 'READY',
      PUBLISHED_AT: ''
    })],
    config: { TEST_MODE: 'TRUE' },
    activeCell: { row: 2 },
    routes: [templateRoute(2)]
  });

  const first = call(s.ctx, 'publishSelectedArticle');
  const second = call(s.ctx, 'publishSelectedArticle');
  eq(first.code, 'TEST_MODE', '1re simulation bloquée');
  eq(second.code, 'TEST_MODE', '2e simulation bloquée');
  eq(s.fetch.calls.filter((c) => c.method !== 'get').length, 0, 'toujours 0 write');
  eq(status(s.ctx, 'TEST-001'), 'READY', 'statut inchangé');
});

test('TEST-001 : le rendu complet fonctionne si les deux verrous sont ouverts', () => {
  // Preuve que le défaut était BIEN le type, et non le contenu de la ligne :
  // le même article passe le pipeline complet hors mode test.
  const articlePath = BLOG_DIR + '/fr/test-facture-conforme-maroc.html';
  const articleRoute = '/contents/' + articlePath;
  const s = setup({
    articles: [makeArticle({
      ID: 'TEST-001',
      TITLE: 'Comment créer une facture conforme au Maroc',
      CATEGORY: 'guides-prix',
      SLUG: 'test-facture-conforme-maroc',
      STATUS: 'READY',
      PUBLISHED_AT: ''
    })],
    config: { TEST_MODE: 'FALSE' },
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: articleRoute, code: 404, body: { message: 'Not Found' } },
      { method: 'put', path: articleRoute, body: putResponse(articlePath, 'x', 'sha-t1', 'commit-t1') }
    ]
  });

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'résultat : ' + result.code + ' ' + result.message);
  eq(result.code, 'PUBLISHED', 'code');
  const put = articlePuts(s.fetch, articleRoute)[0];
  ok(put, 'PUT émis');
  const decoded = Buffer.from(JSON.parse(put.payload).content, 'base64').toString('utf8');
  includes(decoded, 'Comment créer une facture conforme au Maroc', 'titre injecté');
  includes(decoded, 'index, follow', 'robots basculés en production');
  notOk(decoded.indexOf('{{') !== -1, 'aucun placeholder résiduel');
  eq(row(s.ctx, 'TEST-001').STATUS, 'PUBLISHED', 'PUBLISHED en feuilles de test');
});

/* ========================================================================== */
/* Réconciliation des index statiques du Blog                                  */
/* ========================================================================== */

suite('Index Blog');

/** Article prêt à publier. */
function tvaArticle(over) {
  return makeArticle(Object.assign({ PUBLISHED_AT: '2026-07-14' }, over || {}));
}

/** Routes minimales : gabarit + création de l'article. */
function publishRoutes(articlePath) {
  const route = '/contents/' + articlePath;
  return [
    templateRoute(),
    { method: 'get', path: route, code: 404, body: { message: 'Not Found' } },
    { method: 'put', path: route, body: putResponse(articlePath, 'x', 'sha-art', 'commit-art'), times: Infinity }
  ];
}

/** Les écritures de la séquence, dans l'ordre où elles ont eu lieu. */
function putPaths(s) {
  return s.fetch.calls.filter((c) => c.method === 'put').map((c) => c.path.split('?')[0]);
}

/** Suffixe des écritures : `/contents/<chemin>`, sans l'URL du dépôt. */
function putSuffixes(s) {
  return putPaths(s).map((p) => p.replace(/^.*\/contents\//, ''));
}

/* ========================================================================== */
/* Architecture de production : 3 fichiers, un seul vrai chemin               */
/* ========================================================================== */

test('T1 : articles.json reprend exactement le markup de production', () => {
  const s = setup({ articles: [tvaArticle()], routes: publishRoutes(ARTICLE_PATH) });

  const built = call(s.ctx, 'articleIndexRow', row(s.ctx, 'A-1'));
  ok(built.ok, 'entrée construite : ' + built.error);
  eqList(Object.keys(built.entry), [
    'lang', 'slug', 'url', 'title', 'excerpt', 'category', 'date',
    'readingTime', 'image', 'imageAlt', 'imageWidth', 'imageHeight', 'translationGroup'
  ], 'champs et ORDRE des clés (le fichier est commité tel quel)');
  eq(built.entry.url, hrefOf(makeArticle()), 'url = /blog/{LANG}/{SLUG}.html');
  eq(built.entry.category, 'guides-prix', 'catégorie = slug de CATEGORY_MAP');
  eq(built.entry.date, '2026-07-14', 'date de publication');
  eq(built.entry.readingTime, 6, 'temps de lecture numérique');
  eq(built.entry.imageWidth, 1200, 'largeur d\'image');
  eq(built.entry.translationGroup, 'article-de-test', 'groupe de traduction');
});

test('T2 : index en retard → article, puis articles.json, puis sitemap', () => {
  const a = tvaArticle();
  const s = setup({
    articles: [a],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH)
  });

  // État de départ : l'article est absent des DEUX index.
  eq(jsonArticles(s.fetch).length, 0, 'absent de articles.json');
  notOk(sitemapLocs(s.fetch.file(SITEMAP_FILE)).indexOf(SITE + hrefOf(a)) !== -1, 'absent du sitemap');

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'publication : ' + result.code + ' ' + result.message);
  eq(result.status, 'PUBLISHED', 'statut');
  eq(result.indexed, true, 'index réconcilié');
  eq(result.indexWrites, 2, 'articles.json + sitemap');

  // SÉQUENCE IMPOSÉE : le fichier article d'abord, puis les index entre eux.
  eqList(putSuffixes(s), [ARTICLE_PATH, ARTICLES_JSON, SITEMAP_FILE], 'ordre exact des écritures');

  // Contenu réellement écrit sur le disque mocké.
  const entries = jsonArticles(s.fetch);
  eq(entries.length, 1, 'articles.json contient l\'article');
  eq(entries[0].url, hrefOf(a), 'entrée = /blog/fr/article-de-test.html');

  const sm = s.fetch.file(SITEMAP_FILE);
  includes(sitemapLocs(sm), SITE + hrefOf(a), '<loc> ajouté');
  includes(sm, '<lastmod>2026-07-14</lastmod>', '<lastmod> = date de publication');
  includes(sm, '<priority>0.8</priority>', 'priorité conforme au format existant');
  includes(sm, '</urlset>', '</urlset> préservé');
});

test('T3 : index déjà à jour → aucune écriture, résultat UNCHANGED', () => {
  const a = tvaArticle();

  // 1re publication : index en retard, donc 2 écritures d'index.
  const s1 = setup({
    articles: [a],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH)
  });
  const first = call(s1.ctx, 'publishSelectedArticle');
  ok(first.ok, 'première publication : ' + first.code + ' ' + first.message);
  eq(first.indexWrites, 2, '2 écritures à la première publication');

  // 2e publication dans un contexte NEUF, qui repart de l'état ATTEINT : les
  // index tels qu'ils sont sur le disque, et l'article tel qu'il a été écrit
  // (récupéré dans la charge utile du PUT, seul endroit où il existe).
  const s2 = setup({
    articles: [a],
    indexFiles: repoSnapshot(s1.fetch).concat([{ path: ARTICLE_PATH, content: publishedHtml(s1), sha: 'sha-art' }]),
    activeCell: { row: 2 },
    routes: [
      templateRoute(),
      { method: 'get', path: ARTICLE_ROUTE, body: contentsResponse(ARTICLE_PATH, publishedHtml(s1), 'sha-art'), times: Infinity }
    ]
  });

  const again = call(s2.ctx, 'publishSelectedArticle');
  ok(again.ok, 'republication : ' + again.code);
  eq(again.code, 'UNCHANGED', 'article identique');
  eq(again.indexed, true, 'toujours réconcilié');
  eq(again.indexWrites, 0, 'AUCUNE écriture d\'index');
  eq(putPaths(s2).length, 0, 'aucun PUT du tout');
});

test('T4 : le sitemap n\'est jamais dupliqué', () => {
  const s = setup({ articles: [tvaArticle()], indexes: false });
  const loc = SITE + hrefOf(makeArticle());
  const base = sitemapFixture([SITE + '/', { loc: SITE + '/blog/', changefreq: 'weekly' }]);

  const once = call(s.ctx, 'insertIntoSitemap', base, loc, '2026-07-14');
  ok(once.ok, 'première insertion valide');
  eq(once.changed, true, 'première insertion : le contenu change');

  const twice = call(s.ctx, 'insertIntoSitemap', once.html, loc, '2026-07-14');
  ok(twice.ok, 'seconde insertion valide');
  eq(twice.changed, false, 'déjà présent : aucun changement');
  eq(twice.html, once.html, 'contenu strictement identique');
  eq(sitemapLocs(once.html).filter((l) => l === loc).length, 1, 'un seul <loc>');
  eq(once.html.split('\n').filter((l) => l.indexOf('<urlset') !== -1).length, 1, 'un seul urlset');
  // Une URL absente est refusée, pas écrite à moitié.
  eq(call(s.ctx, 'insertIntoSitemap', base, '', '2026-07-14').ok, false, 'URL absente refusée');

  /* --- Mise en forme : l'entrée doit être indiscernable des entrées voisines ---
   * Le sitemap de production indente chaque entrée de 2 espaces, un `<loc>` par
   * ligne, et laisse `</urlset>` seul sur sa ligne. Un saut de ligne en trop
   * produirait une ligne vide ; l'absence du saut de fin collerait `</urlset>`
   * à la dernière entrée. */
  const lines = once.html.split('\n');
  const locLine = lines.findIndex((l) => l.indexOf(loc) !== -1);
  ok(locLine > 5, 'entrée ajoutée après les entrées d\'origine');
  eq(lines[locLine - 1].slice(2, 7), '<url>', '<url> ouvre l\'entrée, juste avant <loc>');
  eq(lines[locLine - 1].slice(0, 2), '  ', 'entrée indentée de 2 espaces');
  eq(lines[locLine].slice(4, 9), '<loc>', '<loc> indenté de 4 espaces');
  eq(lines[locLine + 1], '    <lastmod>2026-07-14</lastmod>', 'lastmod = date de publication');
  eq(lines[locLine + 2], '    <changefreq>monthly</changefreq>', 'changefreq mensuel');
  eq(lines[locLine + 3], '    <priority>0.8</priority>', 'priorité du format existant');
  eq(lines[locLine + 4], '  </url>', '</url> refermé et indenté');
  eq(lines[locLine + 5], '</urlset>', '</urlset> sur sa propre ligne');
  eq(once.html.replace(/\n$/, '').split('\n').indexOf(''), -1, 'aucune ligne vide dans tout le sitemap');
  eq(once.html.slice(-10), '</urlset>\n', 'saut de ligne final conservé');
  includes(lines[locLine - 6], SITE + '/blog/</loc>', 'l\'entrée du hub est la dernière d\'origine');
  // L'entrée du hub garde SON changefreq : rien n'est réécrit à l'insertion.
  includes(once.html, '<changefreq>weekly</changefreq>', 'le hub reste en weekly');
});

test('T5 : ce Blog n\'a pas d\'index de catégorie : l\'absence est NORMALE', () => {
  // La catégorie n'apparaît dans AUCUN chemin (`/blog/{LANG}/{SLUG}.html`) :
  // il n'y a donc rien à créer, et l'absence du fichier n'est pas un défaut.
  const a = tvaArticle();
  const s = setup({
    articles: [a],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH)
  });

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'l\'article EST publié : ' + result.code + ' ' + result.message);
  eq(result.status, 'PUBLISHED', 'statut PUBLISHED');
  eq(row(s.ctx, 'A-1').STATUS, 'PUBLISHED', 'PUBLISHED en feuille de test');
  eq(result.indexed, true, 'index réconcilié');
  eq(result.indexWrites, 2, 'articles.json + sitemap');
  notOk(result.warnings.some((w) => w.code === 'IX1'), 'aucun avertissement : rien ne manque');
  eq(result.error || '', '', 'ce n\'est pas une erreur');

  // Aucune écriture, aucune création de fichier pour un index qui n\'existe pas.
  notOk(putPaths(s).some((p) => p.indexOf('/blog/guides-prix/') !== -1), 'aucun PUT de catégorie');
  notOk(s.fetch.has('public/blog/guides-prix/index.html'), 'le fichier n\'a pas été créé');
});

test('T6 : le hub DYNAMIQUE n\'est jamais réécrit', () => {
  // public/blog/index.html n'a pas de liste statique : blog.js construit
  // #b-list depuis articles.json. Y écrire une carte serait futile — elle
  // serait écrasée au prochain rendu — et créerait un commit pour rien.
  const a = tvaArticle();
  const s = setup({
    articles: [a],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH)
  });

  const before = s.fetch.file(HUB_PATH);
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'publication : ' + result.code);
  eq(result.indexWrites, 2, 'seulement articles.json et le sitemap');
  eq(s.fetch.file(HUB_PATH), before, 'octets du hub inchangés');
  notOk(putPaths(s).some((p) => p.indexOf(HUB_PATH) !== -1), 'aucun PUT sur le hub');
});

test('T7 : articles.json est trié par date décroissante, les autres entrées intactes', () => {
  const ancien = makeArticle({
    ID: 'E-1', TITLE: 'Ancien', SLUG: 'ancien', STATUS: 'PUBLISHED',
    GITHUB_PATH: repoPathOf({ LANG: 'fr', SLUG: 'ancien' }) + '.html',
    PUBLISHED_AT: '2026-01-05', TRANSLATION_GROUP: 'ancien', __seeded: true
  });
  const target = tvaArticle();
  const s = setup({
    articles: [ancien, target],
    indexes: { includeArticle: false },
    activeCell: { row: 3 },
    routes: publishRoutes(ARTICLE_PATH)
  });

  const before = jsonArticles(s.fetch);
  eq(before.length, 1, 'un article publié déjà en ligne');
  eq(before[0].slug, 'ancien', 'c\'est l\'ancien');

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'publication : ' + result.code + ' ' + result.message);

  const after = jsonArticles(s.fetch);
  eq(after.length, 2, 'deux articles');
  eq(after[0].slug, target.SLUG, 'le plus récent passe en tête');
  eq(after[1].slug, 'ancien', 'l\'ancien est conservé');
  eqList(after[1], before[0], 'l\'entrée préexistante n\'a pas bougé d\'un octet');
});

test('T8 : ordre des LECTURES garanti, même quand l\'article est déjà à jour', () => {
  const a = tvaArticle();
  const s = setup({
    articles: [a],
    indexes: { includeArticle: false, withFiles: true },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH)
  });
  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'publication : ' + result.code + ' ' + result.message);
  eq(result.indexWrites, 2, 'article déjà publié, index rattrapé : 2 écritures');

  // L'ordre porte sur les LECTURES : la réconciliation doit relire le hub, puis
  // articles.json, puis le sitemap, dans cet ordre, à chaque publication.
  const reads = s.fetch.calls
    .filter((c) => c.method === 'get')
    .map((c) => c.path.replace(/^.*\/contents\//, '').split('?')[0]);
  const indexReads = reads.filter((p) => p === HUB_PATH || p === ARTICLES_JSON || p === SITEMAP_FILE);
  eqList(indexReads, [HUB_PATH, ARTICLES_JSON, SITEMAP_FILE], 'hub, puis articles.json, puis sitemap');

  // L'écriture de l'article précède la PREMIÈRE lecture d'index : sans ça, un
  // échec de réconciliation laisserait un fichier publié hors de tout index.
  const firstIndexRead = s.fetch.calls.findIndex((c) => c.method === 'get' &&
    (c.path.indexOf(HUB_PATH) !== -1 || c.path.indexOf(ARTICLES_JSON) !== -1 || c.path.indexOf(SITEMAP_FILE) !== -1));
  const articlePut = s.fetch.calls.findIndex((c) => c.method === 'put' && c.path.indexOf(ARTICLE_PATH) !== -1);
  ok(articlePut !== -1 && articlePut < firstIndexRead, 'l\'article est écrit AVANT toute lecture d\'index');
});

test('T9 : conflit SHA sur un index → relecture du SHA puis retry borné', () => {
  const a = tvaArticle();
  const s = setup({
    articles: [a],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH),
    // Un seul 409, sur le PUT de articles.json.
    fetchOptions: { failOnce: { path: ARTICLES_JSON, method: 'put', status: 409 } }
  });

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'la publication aboutit malgré le conflit : ' + result.code + ' ' + result.message);
  eq(result.indexed, true, 'index réconcilié après retry');
  eq(result.indexWrites, 2, 'les 2 index ont bien été écrits');

  const jsonPuts = s.fetch.calls.filter((c) => c.method === 'put' && c.path.indexOf(ARTICLES_JSON) !== -1);
  eq(jsonPuts.length, 2, 'conflit puis retry : exactement 2 PUT');
  // Le retry doit transporter le SHA RÉEL relu, pas celui du conflit.
  ok(JSON.parse(jsonPuts[1].payload).sha !== undefined, 'le retry envoie un sha');
  eq(jsonArticles(s.fetch).length, 1, 'articles.json écrit après le retry');
});

/* ========================================================================== */
/* Réciprocité hreflang, arabe, échec d'index                                  */
/* ========================================================================== */

test('T10 : les hreflang du sitemap sont RÉCIPROQUES dans tout le groupe', () => {
  // Le français est DÉJÀ publié et déjà présent dans les deux index ; l'espagnol
  // est la cible. C'est la situation réelle d'une traduction.
  const fr = makeArticle({
    ID: 'H-1', LANG: 'fr', SLUG: 'facture-tva', STATUS: 'PUBLISHED',
    TRANSLATION_GROUP: 'facture-tva', PUBLISHED_AT: '2026-07-14',
    GITHUB_PATH: BLOG_DIR + '/fr/facture-tva.html', __seeded: true
  });
  const es = makeArticle({
    ID: 'H-2', LANG: 'es', SLUG: 'factura-tva', STATUS: 'READY',
    TITLE: 'Factura del IVA', TRANSLATION_GROUP: 'facture-tva', PUBLISHED_AT: '2026-07-14'
  });
  const esPath = BLOG_DIR + '/es/factura-tva.html';
  const s = setup({
    articles: [fr, es],
    indexes: { includeArticle: false, withFiles: true },
    activeCell: { row: 3 },
    routes: publishRoutes(esPath)
  });

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'publication de la traduction : ' + result.code + ' ' + result.message);
  eq(result.status, 'PUBLISHED', 'traduction publiée');
  eq(result.indexWrites, 2, 'articles.json (nouvel article) + sitemap');

  const sm = s.fetch.file(SITEMAP_FILE);
  const block = (loc) => sm.split('<url>').filter((b) => b.indexOf('<loc>' + loc + '</loc>') !== -1)[0] || '';

  // L'entrée ESPAGNOLE cite le français…
  includes(block(SITE + hrefOf(es)), 'hreflang="fr"', 'l\'espagnol pointe vers le français');
  includes(block(SITE + hrefOf(es)), 'href="' + SITE + hrefOf(fr) + '"', 'URL française exacte');
  includes(block(SITE + hrefOf(es)), 'hreflang="x-default"', 'x-default présent');
  includes(block(SITE + hrefOf(es)), 'hreflang="x-default" href="' + SITE + hrefOf(fr) + '"',
    'x-default = français');
  // …et l'entrée FRANÇAISE a été RÉÉCRITE pour pointer vers l'espagnol. Sans
  // cette réconciliation, un lien à sens unique est ignoré par les moteurs.
  includes(block(SITE + hrefOf(fr)), 'hreflang="es"', 'le français pointe vers l\'espagnol');
  includes(block(SITE + hrefOf(fr)), 'href="' + SITE + hrefOf(es) + '"', 'URL espagnole exacte');

  // articles.json suit le même groupe.
  const entries = jsonArticles(s.fetch);
  eq(entries.length, 2, 'les deux langues sont dans articles.json');
  eq(entries.map((e) => e.lang).join(','), 'fr,es', 'trié par date puis langue');
  ok(entries.every((e) => e.translationGroup === 'facture-tva'), 'même groupe de traduction');

  // Et le corps de la page espagnole propose le français.
  const esHtml = Buffer.from(JSON.parse(articlePuts(s.fetch, '/contents/' + esPath)[0].payload).content, 'base64').toString('utf8');
  includes(esHtml, '<link rel="alternate" hreflang="fr" href="' + SITE + hrefOf(fr) + '">',
    'la page espagnole propose le français');
});

test('T11 : un article arabe est rendu en RTL', () => {
  // Le SLUG reste en ASCII (contrainte V15) : c'est la page qui est en arabe, pas
  // l'URL, et c'est bien ce que la production produit.
  const ar = makeArticle({
    ID: 'A-AR', LANG: 'ar', SLUG: 'facture-tva-ar', STATUS: 'READY',
    TITLE: 'فاتورة الضريبة', TRANSLATION_GROUP: 'facture-tva-ar',
    ARTICLE_EXCERPT: 'كيفية إصدار فاتورة الضريبة في المغرب',
    IMAGE_ALT: 'رسم توضيحي لفاتورة'
  });
  const arPath = repoPathOf(ar) + '.html';
  const s = setup({
    articles: [ar],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(arPath)
  });

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'publication : ' + result.code + ' ' + result.message);

  const put = articlePuts(s.fetch, '/contents/' + arPath)[0];
  ok(put, 'PUT émis sur le bon chemin');
  const html = Buffer.from(JSON.parse(put.payload).content, 'base64').toString('utf8');
  includes(html, '<html lang="ar" dir="rtl"', 'la page est en RTL');
  includes(html, 'فاتورة الضريبة', 'titre arabe injecté');
  includes(html, 'كيفية إصدار فاتورة الضريبة في المغرب', 'extrait arabe injecté');
  includes(html, 'dir="rtl"', 'la racine déclarée');
  ok(html.indexOf('{{') === -1, 'aucun placeholder résiduel');
  includes(sitemapLocs(s.fetch.file(SITEMAP_FILE)), SITE + hrefOf(ar),
    'l\'URL arabe entre au sitemap');
  eq(jsonArticles(s.fetch)[0].lang, 'ar', 'articles.json marque la langue');
});

test('T12 : échec d\'index → article PUBLISHED, ERROR explicite, journal ERROR', () => {
  const a = tvaArticle();
  const s = setup({
    articles: [a],
    indexes: { includeArticle: false },
    activeCell: { row: 2 },
    routes: publishRoutes(ARTICLE_PATH),
    // articles.json refuse TOUTE écriture (403 : token sans permission sur ce
    // chemin). C'est une panne PERMANENTE, pas un conflit de commit : elle doit
    // être signalée, pas_AVALÉE par un retry.
    fetchOptions: { fail: { path: ARTICLES_JSON, method: 'put', status: 403, body: { message: 'Forbidden' } } }
  });

  const result = call(s.ctx, 'publishSelectedArticle');
  ok(result.ok, 'le FICHIER article est bien publié : ' + result.code + ' ' + result.message);
  eq(result.code, 'PUBLISHED_INDEX_PENDING', 'code explicite');
  eq(result.status, 'PUBLISHED', 'le fichier existe : le statut reste PUBLISHED');
  eq(result.indexed, false, 'index NON réconcilié');
  eq(row(s.ctx, 'A-1').STATUS, 'PUBLISHED', 'PUBLISHED en feuille');
  ok(row(s.ctx, 'A-1').ERROR.length > 0, 'colonne ERROR renseignée');
  includes(row(s.ctx, 'A-1').ERROR, 'articles.json', 'l\'index fautif est nommé');
  includes(row(s.ctx, 'A-1').ERROR, 'READY', 'la consigne de remédiation est écrite');

  // Le sitemap, lui, a été écrit : l'échec est ISOLÉ, pas global.
  includes(sitemapLocs(s.fetch.file(SITEMAP_FILE)), SITE + hrefOf(a), 'sitemap bien réconcilié');
  eq(result.indexWrites, 1, 'seul le sitemap a pu être écrit');

  // Journal : une ligne ERROR, et le compte rendu opérateur le dit.
  const errors = logRows(s.sheets).filter((r) => r[1] === 'ERROR');
  eq(errors.length, 1, 'exactement une ligne ERROR : ' + JSON.stringify(errors.map((r) => r[7])));
  includes(errors[0][7], 'articles.json', 'le journal nomme le fichier');
  ok(String(errors[0][6]).indexOf(ARTICLE_PATH) !== -1, 'GITHUB_PATH journalisé en colonne 6');
  includes(call(s.ctx, 'formatPublishReport', result), 'NON RÉCONCILIÉ', 'compte rendu explicite');
  includes(call(s.ctx, 'formatPublishReport', result), ARTICLE_PATH, 'chemin de l\'article rappelé');
});

/* -------------------------------------------------------------------------- */

process.stdout.write('\n');
if (failures.length) {
  process.stdout.write('ECHEC : ' + failures.length + ' test(s) en échec, ' + passed + ' réussi(s)\n');
  failures.forEach((f) => process.stdout.write('  [' + f.suite + '] ' + f.name + '\n    ' + f.message + '\n'));
  process.exit(1);
}
process.stdout.write('OK : ' + passed + ' tests réussis (Publisher)\n');
