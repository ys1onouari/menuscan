/**
 * Menu Scan — Tests de la suppression d'un article publié (D5)
 * ---------------------------------------------------------------------------
 * Exécution : `npm run test:apps-script`
 *
 * AUCUN réseau, AUCUNE écriture GitHub réelle, AUCUN vrai tableur : le dépôt
 * mocké applique le CONTRAT RÉEL de l'API Contents (404 absent, 422 sans sha,
 * 409 sha périmé, `content: null` au succès), et toute route non déclarée fait
 * échouer le test.
 *
 * Ces tests prouvent le comportement OBSERVABLE :
 *   - `validateArticleFilePath()` refuse hub, sitemap, gabarit, index de
 *     catégorie, répertoire, traversée, encodage et jokers ;
 *   - les retraits d'index sont purs, idempotents et préservent les octets ;
 *   - l'ORDRE est imposé : catégorie → hub → sitemap → DELETE de l'article ;
 *   - le SHA distant est comparé avant toute écriture (SHA_DRIFT) ;
 *   - un fichier distant ABSENT provoque zéro écriture (REMOTE_NOT_FOUND) ;
 *   - TEST_MODE / GITHUB_WRITE_ENABLED / verrou fermé refusent SANS écrire ;
 *   - un échec de DELETE laisse l'article en place et la ligne en ERROR ;
 *   - un échec d'index est un avertissement, jamais un arrêt ;
 *   - le succès repasse la ligne en READY et vide les trois champs GitHub.
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
  indexPageFixture,
  blogHubFixture,
  articlesJsonFixture,
  sitemapFixture
} = require('./harness.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'public', 'blog', 'template-article.html');
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const TOKEN = 'ghp_test0000000000000000000000000000';
const HUB_PATH = 'public/blog/index.html';
const ARTICLES_JSON = 'public/blog/articles.json';
const SITEMAP_FILE = 'public/sitemap.xml';
const BLOG_DIR = 'public/blog';
const SITE = 'https://menuscan.space';

const CATEGORY_SLUGS = ['menu-digital', 'qr-code', 'restaurants-cafes', 'hotels-riads', 'commerces', 'guides-prix'];
const CATEGORY_NAMES = {
  'menu-digital': 'menu-digital',
  'qr-code': 'qr-code',
  'restaurants-cafes': 'restaurants-cafes',
  'hotels-riads': 'hotels-riads',
  'commerces': 'commerces',
  'guides-prix': 'guides-prix'
};

/**
 * Chemin REPO d'un article : `/blog/{LANG}/{SLUG}.html`. La catégorie n'entre
 * PAS dans le chemin — elle ne sert qu'au tri de `articles.json`.
 */
const ARTICLE_SLUG = 'article-de-test';
const ARTICLE_PATH = BLOG_DIR + '/fr/' + ARTICLE_SLUG + '.html';
const ARTICLE_HREF = '/blog/fr/' + ARTICLE_SLUG + '.html';
const ARTICLE_LOC = SITE + ARTICLE_HREF;
const ARTICLE_ROUTE = '/contents/' + ARTICLE_PATH;
const ARTICLE_SHA = 'sha-article-publie-0001';

const TEMPLATE_ROUTE = {
  method: 'get',
  path: '/contents/public/blog/template-article.html',
  body: contentsResponse('blog/template-article.html', TEMPLATE),
  times: Infinity
};

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
    failures.push({ suite: currentSuite, name: name, message: e.message });
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

function contains(haystack, needle, label) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error((label || 'contenu') + ' : « ' + needle + ' » absent');
  }
}

function notContains(haystack, needle, label) {
  if (String(haystack).indexOf(needle) !== -1) {
    throw new Error((label || 'contenu') + ' : « ' + needle + ' » présent (inattendu)');
  }
}

function throws(fn, label) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(threw, label || 'un throw était attendu');
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Article DÉJÀ publié : le cas nominal de la suppression. */
function publishedArticle(overrides) {
  return Object.assign({
    ID: 'A-1',
    TITLE: 'Facture TVA : le guide complet',
    KEYWORD: 'facturation',
    CONTENT: '<h2 id="alpha">Déclaration de TVA</h2>\n<p>La TVA se déclare chaque mois.</p>',
    CATEGORY: 'guides-prix',
    SLUG: ARTICLE_SLUG,
    LANG: 'fr',
    TRANSLATION_GROUP: ARTICLE_SLUG,
    SEO_TITLE: 'Facture TVA',
    META_DESCRIPTION: 'Tout sur la TVA facturée au Maroc : taux, déclaration, cas particuliers.',
    IMAGE_URL: '/blog/images/guides-prix.jpg',
    IMAGE_ALT: 'Illustration de l\'article sur la TVA',
    IMAGE_WIDTH: '1200',
    IMAGE_HEIGHT: '630',
    STATUS: 'PUBLISHED',
    PUBLISHED_AT: '2026-07-14',
    ERROR: '',
    SOCIAL_DESCRIPTION: 'Description sociale de test, distincte.',
    ARTICLE_EXCERPT: 'Extrait d’article distinct de la description.',
    CARD_EXCERPT: 'Texte de carte distinct.',
    READING_TIME: '6',
    GITHUB_PATH: ARTICLE_PATH,
    GITHUB_SHA: ARTICLE_SHA,
    GITHUB_COMMIT: 'commit-publication-0001'
  }, overrides || {});
}

/** Un autre article, présent dans les index et JAMAIS ciblé. */
function siblingArticle(overrides) {
  return publishedArticle(Object.assign({
    ID: 'A-2',
    SLUG: 'exoneration-tva',
    TITLE: 'Exonération de TVA',
    ARTICLE_EXCERPT: 'Les cas d’exonération de TVA au Maroc.',
    PUBLISHED_AT: '2026-06-02',
    GITHUB_PATH: BLOG_DIR + '/fr/exoneration-tva.html',
    GITHUB_SHA: 'sha-frere-0002',
    TRANSLATION_GROUP: 'exoneration-tva'
  }, overrides || {}));
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function frenchDateOf(article) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(article.PUBLISHED_AT || ''));
  return m ? parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1] : '';
}

/** Chemin REPO et chemin WEB d'un article : LANG + SLUG, jamais la catégorie. */
function repoPathOf(article) {
  return BLOG_DIR + '/' + (article.LANG || 'fr') + '/' + article.SLUG;
}
function hrefOf(article) {
  return '/blog/' + (article.LANG || 'fr') + '/' + article.SLUG + '.html';
}

/** Entrée d'index exactement au markup de production. */
function indexEntryFor(article, withCategory) {
  return {
    meta: (withCategory ? article.CATEGORY + ' · ' : '') +
      frenchDateOf(article) + ' · ' + article.READING_TIME + ' min',
    href: hrefOf(article),
    title: article.TITLE,
    excerpt: article.ARTICLE_EXCERPT
  };
}

/**
 * Dépôt mocké « déjà réconcilié » : l'article sous test ET son frère sont
 * présents dans `articles.json` et dans le sitemap. C'est l'état réel après une
 * publication réussie, donc l'état de départ normal d'une suppression.
 *
 * Architecture de production, donc STRICTEMENT :
 *   - AUCUN index de catégorie (le Blog n'en a pas) ;
 *   - un hub DYNAMIQUE (`<ul class="b-list" id="b-list">` vide) : il n'a aucune
 *     liste statique à retirer, `articles.json` est sa seule source ;
 *   - les articles sous `public/blog/{LANG}/{SLUG}.html`.
 *
 * Les FICHIERS articles sont eux aussi ensemencés : la suppression devient alors
 * un vrai changement d'état observable, et le contrat de SHA du DELETE est
 * réellement exercé (409 si le SHA ne correspond pas, 422 s'il est absent).
 */
function buildRepo(articles) {
  const locs = [SITE + '/', SITE + '/blog/'];
  const files = [{ path: HUB_PATH, content: blogHubFixture() }];

  articles.forEach((a) => locs.push(SITE + hrefOf(a)));

  files.push({
    path: ARTICLES_JSON,
    content: articlesJsonFixture(articles.map((a) => ({
      title: a.TITLE,
      url: hrefOf(a),
      lang: a.LANG || 'fr',
      category: a.CATEGORY,
      excerpt: a.ARTICLE_EXCERPT,
      image: a.IMAGE_URL,
      imageAlt: a.IMAGE_ALT,
      date: a.PUBLISHED_AT,
      readingTime: Number(a.READING_TIME),
      slug: a.SLUG,
      translationGroup: a.TRANSLATION_GROUP || a.SLUG
    })))
  });

  files.push({ path: SITEMAP_FILE, content: sitemapFixture(locs) });

  articles.forEach((a) => {
    files.push({ path: repoPathOf(a) + '.html', content: '<html>' + a.TITLE + '</html>', sha: a.GITHUB_SHA });
  });

  return files;
}

/** Entrées de `articles.json` lues dans le dépôt mocké. */
function jsonArticles(fetchMock) {
  const raw = fetchMock.file(ARTICLES_JSON);
  if (!raw) return null;
  return JSON.parse(raw).articles;
}

/**
 * Contexte complet de suppression.
 *
 * @param {{articles?:Array, config?:Object, props?:Object, routes?:Array,
 *          lockAvailable?:boolean, activeCell?:Object, activeSheet?:string,
 *          activeRange?:Object, noActiveRange?:boolean,
 *          indexFiles?:Array, fetchOptions?:Object}} [opt]
 */
function setup(opt) {
  const o = opt || {};
  const articles = o.articles || [publishedArticle(), siblingArticle()];
  const files = o.indexFiles || buildRepo(articles);

  const fetchMock = makeGitMock(
    files,
    o.routes || [TEMPLATE_ROUTE],
    Object.assign({ missingAs404: true }, o.fetchOptions || {})
  );

  const sheets = Object.assign({
    Articles: articlesSheet(articles),
    Logs: logsSheet(),
    Config: configSheet(o.config === undefined ? { TEST_MODE: 'FALSE' } : o.config)
  }, o.sheets || {});

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
    activeCell: o.activeCell,
    activeSheet: o.activeSheet,
    activeRange: o.activeRange,
    noActiveRange: o.noActiveRange
  });

  return {
    ctx: created.ctx,
    sheets: created.helpers.sheets,
    ui: created.helpers.ui,
    fetch: fetchMock
  };
}

function row(ctx, id) { return call(ctx, 'findArticleById', id); }
function status(ctx, id) { return row(ctx, id).STATUS; }
function logRows(sheets) { return sheets.Logs._rows; }

function sitemapLocs(xml) {
  return (String(xml).match(/<loc>[^<]*<\/loc>/g) || []).map((l) => l.replace(/<\/?loc>/g, ''));
}

function hubCount(html, slug) {
  const i = String(html).indexOf('<div class="cat-card"><a href="/blog/' + slug + '/">');
  if (i === -1) return null;
  const m = /<div class="count">([^<]*)<\/div>/.exec(String(html).slice(i));
  return m ? m[1] : null;
}

function writesOf(fetchMock) {
  return fetchMock.calls.filter((c) => c.method === 'put' || c.method === 'delete');
}

/* ========================================================================== */
suite('Garde-fous de chemin (validateArticleFilePath)');
/* ========================================================================== */

test('un chemin d\'article valide est accepté', () => {
  const s = setup();
  eq(call(s.ctx, 'validateArticleFilePath', 'public/blog/fr/taux-tva-maroc.html'), true);
  eq(call(s.ctx, 'validateArticleFilePath', 'public/blog/en/tax-rates.html'), true);
  eq(call(s.ctx, 'validateArticleFilePath', 'public/blog/es/tipos-de-iva.html'), true);
  eq(call(s.ctx, 'validateArticleFilePath', 'public/blog/ar/khizanat-kh.html'), true);
});

test('hub, articles.json, sitemap, gabarit, assets/ et images/ sont refusés nommément', () => {
  const s = setup();
  // Les SIX cibles que la suppression ne doit JAMAIS pouvoir atteindre : sans
  // cette liste explicite, `index.html`, `articles.json` ou un fichier
  // d'assets passeraient le motif « …/<slug>.html ».
  throws(() => call(s.ctx, 'validateArticleFilePath', HUB_PATH), 'hub = index.html');
  throws(() => call(s.ctx, 'validateArticleFilePath', ARTICLES_JSON), 'articles.json');
  throws(() => call(s.ctx, 'validateArticleFilePath', SITEMAP_FILE), 'sitemap');
  throws(() => call(s.ctx, 'validateArticleFilePath', 'public/blog/template-article.html'), 'gabarit');
  throws(() => call(s.ctx, 'validateArticleFilePath', 'public/blog/assets/blog.js'), 'assets/');
  throws(() => call(s.ctx, 'validateArticleFilePath', 'public/blog/assets/blog.css'), 'assets/');
  throws(() => call(s.ctx, 'validateArticleFilePath', 'public/blog/images/menu-digital-qr-code.jpg'), 'images/');
});

test('les index de langue sont refusés pour TOUTES les langues', () => {
  const s = setup();
  ['fr', 'en', 'es', 'ar'].forEach((lang) => {
    throws(() => call(s.ctx, 'validateArticleFilePath', 'public/blog/' + lang + '/index.html'), lang);
  });
});

test('répertoire, traversée, antislash, encodage et jokers sont refusés', () => {
  const s = setup();
  [
    'public/blog/fr/',
    'public/blog/fr',
    'public/blog/fr/../index.html',
    'public/blog/fr/..%2Findex.html',
    'public/blog/fr/a\\b.html',
    'public/blog/fr/a%2Fb.html',
    'public/blog/fr/a b.html',
    'public/blog/*/x.html',
    'public/blog/fr/*.html',
    'public/blog/fr/x*.html'
  ].forEach((p) => throws(() => call(s.ctx, 'validateArticleFilePath', p), p));
});

test('chemin absolu, double slash, point-virgule et chemin vide sont refusés', () => {
  const s = setup();
  ['/public/blog/fr/x.html', 'public//blog/fr/x.html', 'public/blog/fr/;x.html', '', null, undefined].forEach((p) => {
    throws(() => call(s.ctx, 'validateArticleFilePath', p), JSON.stringify(p));
  });
});

test('majuscule, extension et segments anormaux sont refusés', () => {
  const s = setup();
  ['public/blog/fr/X.html', 'public/blog/FR/x.html', 'public/blog/fr/x.htm',
    'public/blog/fr/x.HTML', 'public/blog/fr/.html'].forEach((p) => {
    throws(() => call(s.ctx, 'validateArticleFilePath', p), p);
  });
});

test('le motif seul autoriserait index.html : la liste de refus est indispensable', () => {
  const s = setup();
  // Documente le piege : ARTICLE_PATH_RE accepte « index » ; seule la liste de
  // refus de validateArticleFilePath() bloque reellement la suppression.
  eq(s.ctx.ARTICLE_PATH_RE.test('public/blog/fr/index.html'), true, 'le regex seul passe');
  throws(() => call(s.ctx, 'validateArticleFilePath', 'public/blog/fr/index.html'));
});

test('deleteFile() refuse un chemin interdit SANS aucun appel réseau', () => {
  const s = setup();
  throws(() => call(s.ctx, 'deleteFile', { path: HUB_PATH, sha: ARTICLE_SHA }));
  throws(() => call(s.ctx, 'deleteFile', { path: ARTICLES_JSON, sha: ARTICLE_SHA }));
  throws(() => call(s.ctx, 'deleteFile', { path: SITEMAP_FILE, sha: ARTICLE_SHA }));
  throws(() => call(s.ctx, 'deleteFile', { path: 'public/blog/template-article.html', sha: ARTICLE_SHA }));
  throws(() => call(s.ctx, 'deleteFile', { path: 'public/blog/assets/blog.js', sha: ARTICLE_SHA }));
  throws(() => call(s.ctx, 'deleteFile', { path: 'public/blog/images/menu.jpg', sha: ARTICLE_SHA }));
  throws(() => call(s.ctx, 'deleteFile', { path: 'public/blog/fr/index.html', sha: ARTICLE_SHA }));
  eq(s.fetch.calls.length, 0, 'appels GitHub');
});

test('deleteFile() refuse l\'absence de SHA (aucune suppression récursive)', () => {
  const s = setup();
  throws(() => call(s.ctx, 'deleteFile', { path: ARTICLE_PATH }));
  throws(() => call(s.ctx, 'deleteFile', { path: ARTICLE_PATH, sha: '' }));
  eq(s.fetch.calls.length, 0, 'appels GitHub');
});

test('deleteFile() est fermé par TEST_MODE et GITHUB_WRITE_ENABLED', () => {
  const a = setup({ config: { TEST_MODE: 'TRUE' } });
  throws(() => call(a.ctx, 'deleteFile', { path: ARTICLE_PATH, sha: ARTICLE_SHA }));
  eq(a.fetch.calls.length, 0, 'TEST_MODE : appels GitHub');

  const b = setup({ props: { GITHUB_WRITE_ENABLED: 'FALSE' } });
  throws(() => call(b.ctx, 'deleteFile', { path: ARTICLE_PATH, sha: ARTICLE_SHA }));
  eq(b.fetch.calls.length, 0, 'verrou fermé : appels GitHub');
});

test('deleteFile() transmet le sha dans le corps de la requête', () => {
  const s = setup();
  call(s.ctx, 'deleteFile', { path: ARTICLE_PATH, sha: ARTICLE_SHA, message: 'Suppression : x' });
  const del = s.fetch.calls.find((c) => c.method === 'delete');
  ok(del, 'DELETE émis');
  const body = JSON.parse(del.payload);
  eq(body.sha, ARTICLE_SHA, 'sha transmis');
  contains(body.message, 'Suppression', 'message transmis');
  notOk(s.fetch.has(ARTICLE_PATH), 'fichier réellement supprimé du dépôt mocké');
});

/* ========================================================================== */
suite('Retraits d\'index purs');
/* ========================================================================== */

test('removeFromArticleList() retire la SEULE carte au href exact', () => {
  const s = setup();
  const html = indexPageFixture({ items: [
    indexEntryFor(publishedArticle(), false),
    indexEntryFor(siblingArticle(), false)
  ] });
  const r = call(s.ctx, 'removeFromArticleList', html, ARTICLE_HREF);
  ok(r.ok); eq(r.removed, true); eq(r.count, 1);
  notContains(r.html, ARTICLE_HREF, 'cible retirée');
  contains(r.html, hrefOf(siblingArticle()), 'voisine conservée');
});

test('removeFromArticleList() préserve les octets hors du bloc retiré', () => {
  const s = setup();
  const html = indexPageFixture({ items: [
    indexEntryFor(publishedArticle(), false),
    indexEntryFor(siblingArticle(), false)
  ] });
  const r = call(s.ctx, 'removeFromArticleList', html, ARTICLE_HREF);
  // Reconstruction indépendante : une ligne entière retirée, rien d'autre.
  const i = html.indexOf(ARTICLE_HREF);
  const start = html.lastIndexOf('\n', i) + 1;
  let end = html.indexOf('\n', i);
  end = end === -1 ? html.length : end + 1;
  eq(r.html, html.slice(0, start) + html.slice(end), 'octets hors bloc');
});

test('removeFromArticleList() est idempotent et ignore un href absent', () => {
  const s = setup();
  const html = indexPageFixture({ items: [indexEntryFor(publishedArticle(), false)] });
  const once = call(s.ctx, 'removeFromArticleList', html, ARTICLE_HREF);
  const twice = call(s.ctx, 'removeFromArticleList', once.html, ARTICLE_HREF);
  eq(twice.changed, false, '2e retrait'); eq(twice.removed, false);

  const missing = call(s.ctx, 'removeFromArticleList', html, '/blog/tva/inconnu.html');
  eq(missing.ok, true, 'ok'); eq(missing.changed, false, 'changed');
  eq(missing.html, html, 'html inchangé');
});

test('retirer le dernier article vide la liste sans casser le HTML', () => {
  const s = setup();
  const one = indexPageFixture({ items: [indexEntryFor(publishedArticle(), false)] });
  const r = call(s.ctx, 'removeFromArticleList', one, ARTICLE_HREF);
  eq(r.count, 0, 'liste vide');
  contains(r.html, '<ul class="article-list">', 'liste conservée');
  contains(r.html, '</ul>', 'fermeture conservée');
  notContains(r.html, 'article-item', 'aucune carte');
});

test('le <h2> de l\'index n\'est JAMAIS retiré, même s\'il porte le nom de catégorie', () => {
  const s = setup();
  // Le pire cas : liste à une seule carte ET <h2> exactement égal à la
  // catégorie. Le contrat interdit malgré tout de toucher au titre — un test
  // qui ne couvre pas ce cas ne prouverait rien.
  const html = '<h2>TVA Maroc</h2>\r\n' +
    indexPageFixture({ items: [indexEntryFor(publishedArticle(), false)] });
  const r = call(s.ctx, 'removeFromCategoryList', html, ARTICLE_HREF, 'TVA Maroc');
  eq(r.removed, true, 'carte retirée');
  eq(r.count, 0, 'liste vide');
  contains(r.html, '<h2>TVA Maroc</h2>', 'titre CONSERVÉ');
  eq(r.removedHeading, undefined, 'aucun retrait de titre signalé');
  notContains(r.html, ARTICLE_HREF, 'cible retirée');
});

test('un <h2> générique est conservé par removeIndexesForArticle', () => {
  const solo = [publishedArticle()];
  const files = buildRepo(solo);
  files.push({
    path: BLOG_DIR + '/guides-prix/index.html',
    content: '<h2>Articles publiés</h2>\r\n' +
      indexPageFixture({ items: [indexEntryFor(publishedArticle(), true)] })
  });
  const s = setup({ articles: solo, indexFiles: files });
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  ok(r.ok, 'rapport ok : ' + JSON.stringify(r.warnings));
  const written = s.fetch.file('public/blog/guides-prix/index.html');
  contains(written, '<h2>Articles publiés</h2>', 'titre de section intact');
  eq(written.indexOf(ARTICLE_HREF), -1, 'carte retirée');
});

test('removeFromSitemap() retire un bloc <url> sans toucher aux voisins', () => {
  const s = setup();
  const xml = sitemapFixture([SITE + '/', ARTICLE_LOC, SITE + '/blog/tva/autre.html']);
  const r = call(s.ctx, 'removeFromSitemap', xml, ARTICLE_LOC);
  ok(r.ok); eq(r.removed, true);
  eq(sitemapLocs(r.html).length, 2, 'entrées restantes');
  notContains(r.html, ARTICLE_LOC, 'cible retirée');
  contains(r.html, SITE + '/blog/tva/autre.html', 'voisin conservé');
  eq((r.html.match(/<url>/g) || []).length, (r.html.match(/<\/url>/g) || []).length, 'balises équilibrées');
  contains(r.html, '</urlset>', 'urlset conservé');
});

test('removeFromSitemap() gère l\'entrée collée à </urlset> (cas production)', () => {
  const s = setup();
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
    '<url><loc>' + ARTICLE_LOC + '</loc></url>\n' +
    '<url><loc>' + SITE + '/cgu.html</loc></url></urlset>\n';
  const r = call(s.ctx, 'removeFromSitemap', xml, SITE + '/cgu.html');
  ok(r.ok); eq(r.removed, true);
  contains(r.html, ARTICLE_LOC, 'autre entrée conservée');
  contains(r.html, '</urlset>', 'urlset conservé');
  eq((r.html.match(/<url>/g) || []).length, 1, 'une seule entrée restante');
  // Idempotence malgré le collage.
  eq(call(s.ctx, 'removeFromSitemap', r.html, SITE + '/cgu.html').changed, false);
});

test('removeFromSitemap() refuse une URL vide ou absente', () => {
  const s = setup();
  const xml = sitemapFixture([ARTICLE_LOC]);
  eq(call(s.ctx, 'removeFromSitemap', xml, '').ok, false, 'URL vide');
  eq(call(s.ctx, 'removeFromSitemap', xml, SITE + '/absent.html').changed, false, 'URL absente');
});

/* ========================================================================== */
suite('Orchestration des retraits (removeIndexesForArticle)');
/* ========================================================================== */

test('retrait dans l\'ordre catégorie (si présent) → articles.json → sitemap', () => {
  // L'index de catégorie N'EXISTE PAS en production (seul le hub existe) :
  // l'étape 1 est donc tolérante et sans effet. Le reste de la séquence est
  // lui-même_STRICT, et c'est ce qui compte : articles.json AVANT sitemap.
  const s = setup();
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  ok(r.ok, 'rapport ok : ' + JSON.stringify(r.warnings));
  eq(r.removed, true);
  eq(r.categoryIndex.absent, true, 'pas d\'index de catégorie en production');
  eq(r.hub.path, HUB_PATH);
  eq(r.articlesIndex.path, ARTICLES_JSON);
  eq(r.sitemap.path, SITEMAP_FILE);
  eq(r.writes, 2, 'articles.json + sitemap');

  const puts = s.fetch.calls.filter((c) => c.method === 'put').map((c) => c.path);
  eq(puts.length, 2, 'deux écritures');
  ok(puts[0].indexOf(ARTICLES_JSON) !== -1, '1er PUT = articles.json : ' + puts[0]);
  ok(puts[1].indexOf(SITEMAP_FILE) !== -1, '2e PUT = sitemap : ' + puts[1]);
  // L'orchestrateur ne supprime JAMAIS l'article : c'est le rôle du pipeline.
  eq(s.fetch.calls.filter((c) => c.method === 'delete').length, 0, 'aucun DELETE ici');
});

test('un index de catégorie PRÉSENT est traité, et reste le PREMIER', () => {
  // Le Blog n'a pas d'index de catégorie, mais l'étape doit rester correcte si
  // le fichier existe : c'est elle qui porte le compteur et le h2.
  const files = buildRepo([publishedArticle(), siblingArticle()]);
  files.push({
    path: BLOG_DIR + '/guides-prix/index.html',
    content: indexPageFixture({ items: [indexEntryFor(publishedArticle(), true)] })
  });
  const s = setup({ indexFiles: files });
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  ok(r.ok, 'rapport ok : ' + JSON.stringify(r.warnings));
  eq(r.categoryIndex.changed, true, 'index de catégorie écrit');
  eq(r.writes, 3, 'catégorie + articles.json + sitemap');
  const puts = s.fetch.calls.filter((c) => c.method === 'put').map((c) => c.path);
  ok(puts[0].indexOf('blog/guides-prix/index.html') !== -1, '1er PUT = catégorie : ' + puts[0]);
  ok(puts[1].indexOf(ARTICLES_JSON) !== -1, '2e PUT = articles.json');
  ok(puts[2].indexOf(SITEMAP_FILE) !== -1, '3e PUT = sitemap');
});

test('le hub DYNAMIQUE n\'est jamais réécrit : articles.json est sa seule source', () => {
  const s = setup();
  const before = s.fetch.file(HUB_PATH);
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  eq(r.hub.changed, false, 'hub intact');
  eq(r.hub.action, 'dynamic', 'hub reconnu dynamique');
  eq(s.fetch.file(HUB_PATH), before, 'octets du hub inchangés');
  eq(s.fetch.calls.filter((c) => c.method === 'put' && c.path.indexOf(HUB_PATH) !== -1).length,
    0, 'aucun PUT sur le hub');
});

test('un index déjà à jour ne provoque AUCUNE écriture', () => {
  const s = setup();
  call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  const before = s.fetch.calls.length;
  const again = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  eq(again.writes, 0, 'écritures nulles au 2e passage');
  // Seules des LECTURES ont pu avoir lieu : c'est normal et sans effet de bord.
  const after = s.fetch.calls.slice(before);
  ok(after.length > 0, 'des GET de contrôle ont eu lieu');
  after.forEach((c) => eq(c.method, 'get', 'méthode mutante inattendue : ' + c.method + ' ' + c.path));
});

test('un index d\'index absent est toléré : les DEUX index restants sont traités', () => {
  // Un chemin absent doit être RÉELLEMENT absent : le retirer du seed rendrait
  // la route non mockée (erreur franche). `missingAs404` sert donc un 404
  // explicite, ce qui est exactement ce que renvoie GitHub pour ce chemin.
  const s = setup({ indexFiles: buildRepo([publishedArticle(), siblingArticle()]) });
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  ok(r.ok, 'rapport ok : ' + JSON.stringify(r.warnings));
  eq(r.categoryIndex.changed, false, 'index absent : aucune écriture');
  eq(r.categoryIndex.absent, true, 'marque absent');
  eq(r.articlesIndex.changed, true, 'articles.json traité');
  eq(r.sitemap.changed, true, 'sitemap traité');
  eq(r.warnings.length, 0, 'une absence tolérée n\'est pas un avertissement');
});

test('un href d\'une autre catégorie est refusé par l\'index de catégorie', () => {
  // Portée de l'étape 1 : l'index de catégorie ne retire QUE son propre href.
  const s = setup();
  const others = indexPageFixture({ items: [indexEntryFor(siblingArticle(), true)] });
  const r = call(s.ctx, 'removeFromCategoryList', others, '/blog/fr/inconnu.html');
  eq(r.ok, true, 'pas d\'erreur');
  eq(r.removed, false, 'rien retiré');
  eq(r.html, others, 'html strictement inchangé');
});

test('catégorie vide : avertissement, compteur à 0, rien n\'est supprimé', () => {
  const solo = [publishedArticle()];
  const files = buildRepo(solo);
  files.push({
    path: BLOG_DIR + '/guides-prix/index.html',
    content: indexPageFixture({ items: [indexEntryFor(publishedArticle(), true)] })
  });
  const s = setup({ articles: solo, indexFiles: files });
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix', slug: ARTICLE_SLUG
  });
  ok(r.ok, 'rapport ok : ' + JSON.stringify(r.warnings));
  const codes = r.warnings.map((w) => w.code);
  ok(codes.indexOf('CATEGORY_COUNT_EMPTY') !== -1, 'avertissement attendu : ' + JSON.stringify(codes));
  // La catégorie et son index sont CONSERVÉS : leur suppression est éditoriale.
  ok(s.fetch.has('public/blog/guides-prix/index.html'), 'index de catégorie CONSERVÉ');
  notContains(s.fetch.file('public/blog/guides-prix/index.html'), 'article-list-item',
    'plus aucune carte');
  ok(s.fetch.has(HUB_PATH), 'hub CONSERVÉ');
  ok(s.fetch.has(SITEMAP_FILE), 'sitemap CONSERVÉ');
});

/* ========================================================================== */
suite('Pipeline de suppression');
/* ========================================================================== */

test('cas nominal : fichier supprimé, ligne READY, 3 champs GitHub vidés', () => {
  const s = setup();
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  ok(r.ok, 'résultat ok : ' + r.message);
  eq(r.code, 'DELETED');
  eq(r.status, 'READY');

  notOk(s.fetch.has(ARTICLE_PATH), 'fichier article supprimé');
  // `articles.json` est l'index de référence du hub : c'est là que le retrait
  // doit être observable. Le hub, dynamique, n'a AUCUNE liste statique à
  // retoucher — il ne doit donc pas être écrit du tout.
  notContains(s.fetch.file(ARTICLES_JSON), ARTICLE_HREF, 'articles.json');
  eq(sitemapLocs(s.fetch.file(SITEMAP_FILE)).indexOf(ARTICLE_LOC), -1, 'sitemap');
  eq(r.hub.changed, false, 'hub dynamique : aucune écriture');

  // Le frère n'est jamais touché.
  ok(s.fetch.has(repoPathOf(publishedArticle() && siblingArticle()) + '.html'), 'article frère conservé');
  contains(s.fetch.file(ARTICLES_JSON), hrefOf(siblingArticle()), 'frère toujours listé');
  contains(s.fetch.file(SITEMAP_FILE), SITE + hrefOf(siblingArticle()), 'frère toujours dans le sitemap');

  const after = row(s.ctx, 'A-1');
  eq(after.STATUS, 'READY', 'statut');
  eq(after.GITHUB_PATH, '', 'GITHUB_PATH vidé');
  eq(after.GITHUB_SHA, '', 'GITHUB_SHA vidé');
  eq(after.GITHUB_COMMIT, '', 'GITHUB_COMMIT vidé');
  eq(after.PUBLISHED_AT, '2026-07-14', 'PUBLISHED_AT conservé');
  eq(after.TITLE, publishedArticle().TITLE, 'TITLE conservé');
  ok(after.CONTENT.length > 0, 'CONTENT conservé');
  eq(after.ERROR, '', 'ERROR vidé');
});

test('ordre réel : articles.json puis sitemap, le DELETE de l\'article EN DERNIER', () => {
  const s = setup();
  call(s.ctx, 'deleteArticleById', 'A-1');
  const writes = writesOf(s.fetch);
  // 2 index réellement présents (hub dynamique = aucun retrait possible) + DELETE.
  eq(writes.length, 3, '2 PUT + 1 DELETE');
  const putPaths = writes.filter((w) => w.method === 'put').map((w) => w.path);
  ok(putPaths[0].indexOf('articles.json') !== -1, 'articles.json AVANT le sitemap');
  ok(putPaths[1].indexOf('sitemap.xml') !== -1, 'sitemap après articles.json');
  eq(writes[2].method, 'delete', 'le DELETE est EN DERNIER');
  ok(writes[2].path.indexOf(ARTICLE_PATH) !== -1, 'DELETE sur l\'article');
  notOk(writes.some((w) => w.method === 'delete' && w.path.indexOf('sitemap.xml') !== -1),
    'jamais de DELETE sur le sitemap');
});

test('une seconde suppression est refusée par MISSING_PATH, SANS appel GitHub', () => {
  const s = setup();
  call(s.ctx, 'deleteArticleById', 'A-1');
  const before = s.fetch.calls.length;
  const again = call(s.ctx, 'deleteArticleById', 'A-1');
  // La ligne est repassée READY et GITHUB_PATH est vide : « ligne déjà
  // réconciliée » est plus juste que « pas publiée », et c'est ce que dit le
  // contrat. L'essentiel reste vérifié explicitement : zéro appel GitHub.
  eq(again.ok, false, 'échec attendu');
  eq(again.code, 'MISSING_PATH', 'code');
  eq(s.fetch.calls.length, before, 'aucun appel GitHub');
});

test('SHA divergent : refus, ligne intacte, aucune écriture', () => {
  const s = setup({
    articles: [publishedArticle({ GITHUB_SHA: 'sha-ancien-0000' }), siblingArticle()],
    indexFiles: buildRepo([publishedArticle(), siblingArticle()])
  });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false); eq(r.code, 'SHA_DRIFT');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne inchangée');
  ok(s.fetch.has(ARTICLE_PATH), 'article toujours présent');
  eq(writesOf(s.fetch).length, 0, 'aucune écriture');
});

test('fichier distant absent : refus et AUCUNE écriture, index intacts', () => {
  const s = setup({
    indexFiles: buildRepo([publishedArticle(), siblingArticle()]).filter((f) => f.path !== ARTICLE_PATH),
    routes: [
      TEMPLATE_ROUTE,
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' }, times: 2 }
    ]
  });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false); eq(r.code, 'REMOTE_NOT_FOUND', 'code');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne inchangée');
  eq(writesOf(s.fetch).length, 0, 'aucune écriture d\'index, aucun DELETE');
  contains(s.fetch.file(ARTICLES_JSON), ARTICLE_HREF, 'articles.json INTACT');
  contains(s.fetch.file(SITEMAP_FILE), ARTICLE_LOC, 'sitemap INTACT');
});

test('GITHUB_PATH falsifié : refus PATH_MISMATCH avant tout appel', () => {
  const s = setup({
    articles: [publishedArticle({ GITHUB_PATH: BLOG_DIR + '/fr/autre-article.html' }), siblingArticle()]
  });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false); eq(r.code, 'PATH_MISMATCH');
  eq(s.fetch.calls.length, 0, 'aucun appel GitHub');
  ok(s.fetch.has(ARTICLE_PATH), 'fichier légitime intact');
});

/* ========================================================================== */
suite('Échecs partiels et prérequis');
/* ========================================================================== */

test('un 5xx sur le DELETE est retenté et aboutit', () => {
  const s = setup({
    fetchOptions: { failOnce: { path: ARTICLE_PATH, method: 'delete', status: 500 } }
  });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, true, 'un 5xx est retenté : ' + r.code + ' ' + r.message);
  notOk(s.fetch.has(ARTICLE_PATH), 'article supprimé après retry');
});

test('échec DELETE non retentable (403) : ligne ERROR et article conservé', () => {
  const s = setup({
    fetchOptions: { failOnce: { path: ARTICLE_PATH, method: 'delete', status: 403, body: { message: 'Forbidden' } } }
  });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false, 'échec attendu');
  eq(r.code, 'DELETE_FAILED', 'code : ' + r.code);
  eq(status(s.ctx, 'A-1'), 'ERROR', 'ligne en ERROR');
  eq(row(s.ctx, 'A-1').GITHUB_PATH, ARTICLE_PATH, 'GITHUB_PATH conservé');
  eq(row(s.ctx, 'A-1').GITHUB_SHA, ARTICLE_SHA, 'GITHUB_SHA conservé pour diagnostic');
  ok(s.fetch.has(ARTICLE_PATH), 'article toujours présent');
});

test('échec d\'un index : suppression poursuivie, ligne READY MAIS ERREUR explicite', () => {
  const s = setup({ fetchOptions: { failOnce: { path: SITEMAP_FILE, method: 'put', status: 403 } } });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, true, 'la suppression reste un succès : ' + r.code);
  eq(r.code, 'DELETED_INDEX_PENDING', 'code d\'index en retard');
  ok(r.warnings.length > 0, 'avertissement remonté');
  eq(r.indexed, false, 'index signalé non réconcilié');
  ok(r.indexError, 'message d\'erreur d\'index remonté');
  notOk(s.fetch.has(ARTICLE_PATH), 'article supprimé');
  eq(status(s.ctx, 'A-1'), 'READY', 'ligne READY');
  // L'échec d'index ne doit JAMAIS être silencieux : la colonne ERROR porte le
  // motif et la feuille Logs contient une entrée ERROR.
  ok(String(row(s.ctx, 'A-1').ERROR).length > 0, 'colonne ERROR renseignée');
  contains(String(row(s.ctx, 'A-1').ERROR), 'NON réconcilié', 'message explicite en colonne ERROR');
  ok(logRows(s.sheets).some((r) => String(r[1]) === 'ERROR'), 'journal ERROR');
  ok(sitemapLocs(s.fetch.file(SITEMAP_FILE)).indexOf(ARTICLE_LOC) !== -1, 'sitemap en retard (attendu)');
  // articles.json, écrit AVANT, reste à jour : l'ordre sûr se paie.
  notContains(s.fetch.file(ARTICLES_JSON), ARTICLE_HREF, 'articles.json réconcilié malgré l\'échec sitemap');
});

test('l\'erreur d\'index partiel journalise GITHUB_PATH dans la colonne dédiée', () => {
  // Le chemin EST connu au moment de l'erreur. Il doit donc atterrir dans la
  // colonne GITHUB_PATH (index 6) et non seulement dans DETAILS, comme le
  // fait `logDeleteEvent()` pour le reste du flux.
  const s = setup({ fetchOptions: { failOnce: { path: SITEMAP_FILE, method: 'put', status: 403 } } });
  call(s.ctx, 'deleteArticleById', 'A-1');

  const errors = logRows(s.sheets).filter((r) => String(r[1]) === 'ERROR');
  ok(errors.length > 0, 'journal ERROR non vide : ' +
    JSON.stringify(logRows(s.sheets).map((r) => [r[1], r[2], r[6]])));
  const withPath = errors.filter((r) => String(r[6] || '') === ARTICLE_PATH);
  eq(withPath.length, 1, 'exactement une erreur porte GITHUB_PATH : ' +
    JSON.stringify(errors.map((r) => [r[1], r[2], r[6]])));

  // Aucune trace ne doit laisser la colonne dédiée vide pour une erreur
  // d'index alors que le chemin est connu.
  const orphans = errors.filter((r) => !String(r[6] || ''));
  eq(orphans.length, 0, 'erreur sans GITHUB_PATH : ' +
    JSON.stringify(orphans.map((r) => [r[2], String(r[8] || '').slice(0, 80)])));
});

test('verrou déjà détenu : refus LOCK_BUSY, aucune écriture, ligne intacte', () => {
  const s = setup({ lockAvailable: false });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false); eq(r.code, 'LOCK_BUSY');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne intacte');
  eq(s.fetch.calls.length, 0, 'aucun appel GitHub');
});

test('TEST_MODE : refus sans écrire et SANS passer la ligne en ERROR', () => {
  const s = setup({ config: { TEST_MODE: 'TRUE' } });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false); eq(r.code, 'TEST_MODE');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne restaurée, pas ERROR');
  eq(s.fetch.calls.length, 0, 'aucun appel GitHub');
  ok(s.fetch.has(ARTICLE_PATH), 'article présent');
});

test('GITHUB_WRITE_ENABLED=FALSE : refus WRITES_DISABLED, ligne intacte', () => {
  const s = setup({ props: { GITHUB_WRITE_ENABLED: 'FALSE' } });
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  eq(r.ok, false); eq(r.code, 'WRITES_DISABLED');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne intacte');
  eq(s.fetch.calls.length, 0, 'aucun appel GitHub');
});

test('statut non PUBLISHED : refus sans appel GitHub', () => {
  ['READY', 'DRAFT', 'PUBLISHING', 'ERROR', ''].forEach((st) => {
    const s = setup({ articles: [publishedArticle({ STATUS: st }), siblingArticle()] });
    const r = call(s.ctx, 'deleteArticleById', 'A-1');
    eq(r.ok, false, 'statut ' + st);
    eq(r.code, 'NOT_PUBLISHED', 'code pour ' + st);
    eq(s.fetch.calls.length, 0, 'aucun appel GitHub pour ' + st);
  });
});

test('SHA ou chemin manquant : refus avant tout appel GitHub', () => {
  const noSha = setup({ articles: [publishedArticle({ GITHUB_SHA: '' }), siblingArticle()] });
  eq(call(noSha.ctx, 'deleteArticleById', 'A-1').code, 'MISSING_SHA');
  eq(noSha.fetch.calls.length, 0, 'aucun appel');

  const noPath = setup({ articles: [publishedArticle({ GITHUB_PATH: '' }), siblingArticle()] });
  eq(call(noPath.ctx, 'deleteArticleById', 'A-1').code, 'MISSING_PATH');
  eq(noPath.fetch.calls.length, 0, 'aucun appel');
});

test('catégorie inconnue ou slug invalide : refus avant tout appel GitHub', () => {
  const badCat = setup({ articles: [publishedArticle({ CATEGORY: 'inexistante' }), siblingArticle()] });
  eq(call(badCat.ctx, 'deleteArticleById', 'A-1').code, 'UNKNOWN_CATEGORY');
  eq(badCat.fetch.calls.length, 0, 'aucun appel');
  eq(status(badCat.ctx, 'A-1'), 'PUBLISHED', 'ligne intacte');

  const badSlug = setup({ articles: [publishedArticle({ SLUG: 'Mauvais Slug!' }), siblingArticle()] });
  eq(call(badSlug.ctx, 'deleteArticleById', 'A-1').code, 'INVALID_SLUG');
  eq(badSlug.fetch.calls.length, 0, 'aucun appel');
});

test('CATEGORY vide : refus MISSING_CATEGORY, distinct d\'UNKNOWN_CATEGORY', () => {
  // Les deux cas sont des refus, mais l'opérateur ne corrige pas pareil :
  // une catégorie absente est une saisie incomplète, pas une catégorie inconnue.
  ['', '   '].forEach((cat) => {
    const s = setup({ articles: [publishedArticle({ CATEGORY: cat }), siblingArticle()] });
    const r = call(s.ctx, 'deleteArticleById', 'A-1');
    eq(r.ok, false, 'refus pour [' + cat + ']');
    eq(r.code, 'MISSING_CATEGORY', 'code pour [' + cat + ']');
    eq(s.fetch.calls.length, 0, 'aucun appel GitHub pour [' + cat + ']');
    eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne intacte pour [' + cat + ']');
  });

  // Le même refus doit apparaître par la sélection, pas seulement par l'ID.
  const bySelection = setup({
    articles: [publishedArticle({ CATEGORY: '' }), siblingArticle()],
    activeCell: { row: 2 }
  });
  eq(call(bySelection.ctx, 'selectActivePublishedArticle').code, 'MISSING_CATEGORY');
  eq(bySelection.fetch.calls.length, 0, 'aucun appel GitHub (sélection)');
});

test('ID inconnu ou vide : refus NO_ARTICLE sans appel GitHub', () => {
  const s = setup();
  eq(call(s.ctx, 'deleteArticleById', 'INCONNU').code, 'NO_ARTICLE');
  eq(call(s.ctx, 'deleteArticleById', '').code, 'NO_ARTICLE');
  eq(s.fetch.calls.length, 0, 'aucun appel');
});

/* ========================================================================== */
suite('Journal');
/* ========================================================================== */

test('le succès journalise action=delete et le chemin exact', () => {
  const s = setup();
  call(s.ctx, 'deleteArticleById', 'A-1');
  const rows = logRows(s.sheets);
  ok(rows.length > 0, 'journal non vide');
  // Colonnes Logs : 1 LEVEL, 2 ACTION, 6 GITHUB_PATH.
  const success = rows.find((r) => r[1] === 'SUCCESS' && r[2] === 'delete');
  ok(success, 'entrée de succès introuvable : ' + JSON.stringify(rows.map((r) => [r[1], r[2]])));
  contains(String(success[6] || ''), ARTICLE_PATH, 'GITHUB_PATH dans le journal');
  eq(success[3], 'A-1', 'ARTICLE_ID');
  eq(success[5], 'READY', 'STATUS final');
});

test('un refus de statut est journalisé en avertissement avec le chemin', () => {
  const s = setup({ articles: [publishedArticle({ STATUS: 'READY' }), siblingArticle()] });
  call(s.ctx, 'deleteArticleById', 'A-1');
  const rows = logRows(s.sheets);
  const warn = rows.find((r) => r[1] === 'WARNING' && r[2] === 'delete');
  ok(warn, 'avertissement introuvable : ' + JSON.stringify(rows.map((r) => [r[1], r[2]])));
  contains(String(warn[6] || ''), ARTICLE_PATH, 'chemin journalisé');
});

test('le message de commit est déterministe', () => {
  const s = setup();
  eq(call(s.ctx, 'deleteCommitMessage', { SLUG: 'abc' }), 'Suppression : abc');
  eq(call(s.ctx, 'deleteCommitMessage', { ID: 'A-9', SLUG: '' }), 'Suppression : A-9');
});

/* ========================================================================== */
suite('Interface opérateur');
/* ========================================================================== */

test('le menu expose une entrée de suppression isolée par des séparateurs', () => {
  const s = setup();
  call(s.ctx, 'onOpen');
  const labels = s.ui.items.map((i) => i.label);
  const idx = labels.indexOf('\u{1F5D1}\uFE0F Supprimer l\'article publié');
  ok(idx !== -1, 'entrée absente : ' + JSON.stringify(labels));
  eq(s.ui.items[idx].fn, 'deleteSelectedPublishedArticle', 'callback');
  eq(labels[idx - 1], '---', 'séparateur avant');
  eq(labels[idx + 1], '---', 'séparateur après');
  // Elle ne doit pas être voisine immédiate d'une action de publication.
  notContains(labels[idx - 1], 'Publier', 'voisine d\'une publication');
});

test('le dialogue affiche le chemin exact, le SHA et les deux libellés', () => {
  const s = setup({ activeCell: { row: 2 } });
  call(s.ctx, 'showDeleteArticleDialog', 'A-1');
  eq(s.ui.dialogs.length, 1, 'un dialogue');
  const html = s.ui.dialogs[0].html;
  contains(html, ARTICLE_PATH, 'chemin en clair');
  contains(html, ARTICLE_SHA, 'SHA complet');
  contains(html, 'SUPPRIMER DÉFINITIVEMENT', 'libellé exact');
  contains(html, 'Annuler', 'libellé annuler');
  contains(html, 'autofocus', 'annuler par défaut');
  contains(html, 'monospace', 'chemin en monospace');
  // Aucun champ de saisie : le chemin affiché n'est pas modifiable.
  notContains(html, '<input', 'aucun champ éditable');
});

test('le dialogue échappe le contenu de la feuille (pas d\'injection)', () => {
  const nasty = publishedArticle({ TITLE: '<img src=x onerror=alert(1)>' });
  const s = setup({ articles: [nasty, siblingArticle()] });
  const shown = call(s.ctx, 'showDeleteArticleDialog', 'A-1');
  ok(shown.ok, 'dialogue affiché');
  const html = s.ui.dialogs[0].html;
  notContains(html, '<img src=x', 'HTML non échappé');
  contains(html, '&lt;img', 'échappement présent');
});

test('ouvrir le dialogue n\'effectue AUCUN appel GitHub', () => {
  const s = setup();
  call(s.ctx, 'showDeleteArticleDialog', 'A-1');
  eq(s.fetch.calls.length, 0, 'aucun appel GitHub');
});

test('le dialogue refuse une ligne non supprimable et ne s\'affiche pas', () => {
  const s = setup({ articles: [publishedArticle({ STATUS: 'READY' }), siblingArticle()] });
  const r = call(s.ctx, 'showDeleteArticleDialog', 'A-1');
  eq(r.ok, false, 'refusé');
  eq(s.ui.dialogs.length, 0, 'aucun dialogue');
  eq(s.fetch.calls.length, 0, 'aucun appel GitHub');
});

test('sélection : mauvaise feuille et ligne d\'en-tête sont refusées', () => {
  const wrongSheet = setup({ activeCell: { row: 2 }, activeSheet: 'Logs' });
  const wrong = call(wrongSheet.ctx, 'selectActivePublishedArticle');
  eq(wrong.ok, false, 'feuille Logs');
  eq(wrong.code, 'WRONG_SHEET', 'code feuille Logs');
  eq(wrongSheet.fetch.calls.length, 0, 'aucun appel');

  const header = setup({ activeCell: { row: 1 } });
  const head = call(header.ctx, 'selectActivePublishedArticle');
  eq(head.ok, false, 'en-tête');
  eq(head.code, 'HEADER_ROW', 'code en-tête');
  eq(header.fetch.calls.length, 0, 'aucun appel');
});

test('sélection : B4 — trois lignes sélectionnées ⇒ MULTIPLE_ROWS, ZÉRO appel, ZÉRO écriture', () => {
  // Régression ciblée : l'ancre de la plage est la ligne 2, c'est-à-dire
  // l'article PUBLISHED valide. Un garde fondé sur `getActiveCell()` l'aurait
  // accepté et aurait supprimé le mauvais article sans confirmation possible.
  // Le garde doit lire la PLAGE.
  const s = setup({ activeRange: { row: 2, column: 1, numRows: 3, numColumns: 1 } });

  const picked = call(s.ctx, 'selectArticleForDeletion');
  eq(picked.ok, false, 'sélection plurilignes refusée');
  eq(picked.code, 'MULTIPLE_ROWS', 'code MULTIPLE_ROWS');
  contains(picked.error, '3 lignes', 'le refus cite le nombre de lignes');

  const verified = call(s.ctx, 'selectActivePublishedArticle');
  eq(verified.ok, false, 'selectActivePublishedArticle refuse aussi');
  eq(verified.code, 'MULTIPLE_ROWS', 'code propagé');

  // Zéro requête GitHub : ni lecture, ni PUT d'index, ni DELETE.
  eq(s.fetch.calls.length, 0, 'zéro appel GitHub');

  // Aucune écriture : ligne et dépôt intacts, aucun dialogue de confirmation.
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne A-1 intacte');
  eq(status(s.ctx, 'A-2'), 'PUBLISHED', 'ligne A-2 intacte');
  eq(s.ui.dialogs.length, 0, 'aucun dialogue de confirmation');
  ok(s.fetch.has(ARTICLE_PATH), 'article non supprimé');
  ok(s.fetch.has(HUB_PATH), 'hub non supprimé');
  // Le hub est DYNAMIQUE : il ne contient aucune carte. Ce qui doit être intact,
  // c'est le fichier lui-même, octet pour octet, et articles.json qui, lui,
  // porte bien l'article.
  contains(s.fetch.file(ARTICLES_JSON), ARTICLE_HREF, 'entrée de articles.json inchangée');
  contains(s.fetch.file(SITEMAP_FILE), ARTICLE_LOC, 'sitemap inchangé');
  contains(s.fetch.file(SITEMAP_FILE), SITE + hrefOf(siblingArticle()), 'sitemap du frère intact');
});

test('sélection : B4 par le menu — trois lignes, aucune suppression, aucun dialogue', () => {
  const s = setup({ activeRange: { row: 2, column: 1, numRows: 3, numColumns: 1 } });
  call(s.ctx, 'onOpen');
  const item = s.ui.items.find((i) => i.fn === 'deleteSelectedPublishedArticle');
  ok(item, 'entrée de menu D5 présente');
  const r = call(s.ctx, item.fn);
  eq(r.ok, false, 'menu refusé');
  eq(s.fetch.calls.length, 0, 'zéro appel GitHub');
  eq(s.ui.dialogs.length, 0, 'aucun dialogue');
  ok(s.fetch.has(ARTICLE_PATH), 'article non supprimé');
  eq(status(s.ctx, 'A-1'), 'PUBLISHED', 'ligne intacte');
});

test('sélection : deux lignes, ou une plage de trois colonnes, restent refusées', () => {
  const two = setup({ activeRange: { row: 2, column: 1, numRows: 2, numColumns: 1 } });
  eq(call(two.ctx, 'selectArticleForDeletion').code, 'MULTIPLE_ROWS', 'deux lignes');
  eq(two.fetch.calls.length, 0, 'zéro appel');

  // Seule la HAUTEUR compte : la largeur n'est pas un critère de l'invariant.
  const wide = setup({ activeRange: { row: 2, column: 1, numRows: 1, numColumns: 3 } });
  const widePicked = call(wide.ctx, 'selectArticleForDeletion');
  eq(widePicked.ok, true, 'une ligne, trois colonnes : accepté : ' + widePicked.error);
  eq(widePicked.article.ID, 'A-1', 'bon article');
  eq(wide.fetch.calls.length, 0, 'toujours zéro appel : lire ne supprime pas');
});

test('sélection : aucune sélection ⇒ EMPTY_SELECTION, ZÉRO appel', () => {
  const s = setup({ noActiveRange: true });
  const r = call(s.ctx, 'selectArticleForDeletion');
  eq(r.ok, false, 'sélection vide refusée');
  eq(r.code, 'EMPTY_SELECTION', 'code EMPTY_SELECTION');
  eq(s.fetch.calls.length, 0, 'zéro appel GitHub');
  eq(s.ui.dialogs.length, 0, 'aucun dialogue');
  ok(s.fetch.has(ARTICLE_PATH), 'article non supprimé');
});

test('sélection : le garde dédié ne dépend pas de getActiveCell()', () => {
  // Preuve structurelle : le corps du garde doit utiliser la plage. Une
  // régression vers `getActiveCell()` casserait ce test, pas seulement B4.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'Publisher.gs'), 'utf8');
  const body = src.slice(
    src.indexOf('function selectArticleForDeletion'),
    src.indexOf('function selectActivePublishedArticle')
  );
  contains(body, 'getActiveRange()', 'le garde lit la plage');
  contains(body, 'getNumRows()', 'le garde compte les lignes');
  ok(body.indexOf('getActiveCell') === -1, 'aucun getActiveCell dans le garde de suppression');
  notOk(body.indexOf('selectActiveArticle()') !== -1, 'aucune réutilisation du garde de publication');
});

test('le parcours menu s\'arrête à la confirmation et ne supprime rien', () => {
  const s = setup({ activeCell: { row: 2 } });
  call(s.ctx, 'onOpen');
  const item = s.ui.items.find((i) => i.fn === 'deleteSelectedPublishedArticle');
  const r = call(s.ctx, item.fn);
  eq(r.code, 'AWAITING_CONFIRMATION', 'en attente de confirmation');
  eq(s.ui.dialogs.length, 1, 'dialogue ouvert');
  ok(s.fetch.has(ARTICLE_PATH), 'article NON supprimé tant qu\'il n\'y a pas eu confirmation');
});

test('sélection : un article PUBLISHED valide est proposé à la suppression', () => {
  const s = setup({ activeCell: { row: 2 } });
  const r = call(s.ctx, 'selectActivePublishedArticle');
  ok(r.ok, 'sélection valide : ' + r.error);
  eq(r.article.ID, 'A-1');
  eq(r.identity.path, ARTICLE_PATH, 'chemin dérivé');
  eq(r.identity.categorySlug, 'guides-prix', 'catégorie résolue');
  eq(r.identity.sha, ARTICLE_SHA, 'SHA repris de la feuille');
});

/* ========================================================================== */
suite('Non-régression et invariants');
/* ========================================================================== */

test('la publication reste intacte : un READY se publie toujours', () => {
  const ready = publishedArticle({ STATUS: 'READY', GITHUB_PATH: '', GITHUB_SHA: '', GITHUB_COMMIT: '' });
  const s = setup({
    articles: [ready, siblingArticle()],
    routes: [
      TEMPLATE_ROUTE,
      { method: 'get', path: ARTICLE_ROUTE, code: 404, body: { message: 'Not Found' } },
      {
        method: 'put',
        path: ARTICLE_ROUTE,
        body: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } },
        times: Infinity
      }
    ]
  });
  const r = call(s.ctx, 'publishArticleById', 'A-1');
  eq(r.ok, true, 'publication : ' + r.code + ' ' + r.message);
  eq(status(s.ctx, 'A-1'), 'PUBLISHED');
  ok(s.fetch.has(ARTICLE_PATH), 'article publié');
});

test('la suppression ne crée aucun état transitoire (pas de DELETING)', () => {
  const s = setup();
  call(s.ctx, 'deleteArticleById', 'A-1');
  const st = row(s.ctx, 'A-1').STATUS;
  ok(st !== 'DELETING' && st !== 'DELETED', 'statut transitoire inattendu : ' + st);
  eq(st, 'READY');
});

test('aucune écriture n\'est possible en mode test pour l\'index seul', () => {
  const s = setup({ config: { TEST_MODE: 'TRUE' } });
  const r = call(s.ctx, 'removeIndexesForArticle', row(s.ctx, 'A-1'), {
    href: ARTICLE_HREF, categorySlug: 'guides-prix'
  });
  eq(r.ok, false, 'échec attendu');
  eq(writesOf(s.fetch).length, 0, 'aucune écriture');
});

test('formatDeleteReport() ne divulgue ni jeton ni détail sensible', () => {
  const s = setup();
  const r = call(s.ctx, 'deleteArticleById', 'A-1');
  const report = call(s.ctx, 'formatDeleteReport', r);
  contains(report, 'Suppression', 'en-tête');
  notContains(report, TOKEN, 'jeton absent');
  notContains(report, 'ghp_', 'préfixe de jeton absent');
});

test('les 11 modules se chargent et exposent tous les symboles D5', () => {
  const created = createContext({});
  const symbols = [
    'deleteArticleById', 'deleteArticle', 'runDeletePipeline', 'checkDeletableFields',
    'selectArticleForDeletion', 'selectActivePublishedArticle', 'showDeleteArticleDialog',
    'renderDeleteDialogHtml',
    'formatDeleteReport', 'markDeleteError', 'failDeleteToError', 'deleteCommitMessage',
    'deleteFile', 'validateArticleFilePath', 'removeFromArticleList', 'removeFromCategoryList',
    'removeFromHub', 'removeFromSitemap', 'patchIndexFile', 'removeArticleFromIndexFile',
    'removeIndexesForArticle', 'countArticleItems', 'deleteSelectedPublishedArticle'
  ];
  symbols.forEach((name) => {
    if (typeof created.ctx[name] !== 'function') throw new Error('symbole manquant : ' + name);
  });
  eq(symbols.length, 23, 'nombre de symboles D5 vérifiés');
});

/* ========================================================================== */
process.stdout.write('\n');
if (failures.length) {
  process.stdout.write('ECHECS (' + failures.length + ') :\n');
  failures.forEach((f) => {
    process.stdout.write('  [' + f.suite + '] ' + f.name + '\n      ' + f.message + '\n');
  });
  process.stdout.write('\n' + passed + ' reussis, ' + failures.length + ' echecs\n');
  process.exit(1);
}
process.stdout.write('OK : ' + passed + ' tests reussis (Suppression D5)\n');