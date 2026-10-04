/**
 * Menu Scan — Tests du hub Blog (public/blog/assets/blog.js)
 * ---------------------------------------------------------------------------
 * Exécution : `node apps-script/tests/hub.test.cjs`
 *
 * Complément des tests du moteur : le moteur peut écrire un `articles.json`
 * PARFAIT et le hub afficher encore une liste vide. Ces scénarios chargent le
 * VRAI fichier du dépôt dans un DOM minimal (aucune dépendance, aucun réseau) et
 * prouvent ce que voit le visiteur :
 *   - un article à catégorie INCONNUE reste affiché et reçoit son filtre ;
 *   - un article à catégorie VIDE reste affiché, dans le bucket de repli ;
 *   - le filtrage par langue reste STRICT, sans repli ni état incohérent ;
 *   - l'ordre d'affichage reste déterministe (date décroissante, slug croissant).
 *
 * Aucun bundler, aucun jsdom : `blog.js` n'utilise que `document`, `window`,
 * `localStorage`, `navigator` et `fetch`.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'blog', 'assets', 'blog.js'), 'utf8');

/* -------------------------------------------------------------------------- */
/* Micro-framework (asynchrone : le rendu suit une promesse fetch)             */
/* -------------------------------------------------------------------------- */

const tests = [];
let currentSuite = '';

function suite(name) { currentSuite = name; }

function test(name, fn) { tests.push({ suite: currentSuite, name, fn }); }

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      (label || 'valeur') + ' : attendu ' + JSON.stringify(expected) +
      ', obtenu ' + JSON.stringify(actual));
  }
}

function ok(value, label) {
  if (!value) throw new Error((label || 'condition') + ' : falsy (' + JSON.stringify(value) + ')');
}

function includes(haystack, needle, label) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error((label || 'texte') + ' : ' + JSON.stringify(needle) +
      ' absent de ' + JSON.stringify(String(haystack).slice(0, 400)));
  }
}

function excludes(haystack, needle, label) {
  if (String(haystack).indexOf(needle) !== -1) {
    throw new Error((label || 'texte') + ' : ' + JSON.stringify(needle) +
      ' PRÉSENT dans ' + JSON.stringify(String(haystack).slice(0, 400)));
  }
}

/** Laisse le temps au fetch mocké et à ses `.then` de se vider. */
function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/* -------------------------------------------------------------------------- */
/* DOM minimal                                                                 */
/* -------------------------------------------------------------------------- */

function makeElement(id) {
  return {
    id: id,
    className: '',
    innerHTML: '',
    textContent: '',
    attrs: {},
    children: [],
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    addEventListener() {},
    appendChild(node) { this.children.push(node); return node; },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
}

/**
 * Charge `blog.js` et rend le hub.
 * @param {{articles:Array, search?:string, browser?:string, stored?:string}} o
 * @return {Promise<{list, count, filters, html}>}
 */
function mountHub(o) {
  const els = {
    'b-list': makeElement('b-list'),
    'b-count': makeElement('b-count'),
    'b-filters': makeElement('b-filters')
  };
  const store = {};
  if (o.stored) store.i18nextLng = o.stored;
  const browser = o.browser || 'fr';

  const sandbox = {
    URLSearchParams: URLSearchParams,
    console: console,
    document: {
      readyState: 'complete',
      documentElement: {},
      getElementById: (id) => (Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null),
      querySelectorAll: () => [],
      createElement: () => makeElement('created')
    },
    window: { location: { search: o.search || '' } },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    navigator: { languages: [browser], language: browser },
    fetch: (url) => {
      sandbox.fetched = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ version: 1, generatedAt: '2026-10-04T00:00:00.000Z', articles: o.articles })
      });
    }
  };

  vm.runInNewContext(SOURCE, sandbox, { filename: 'blog.js' });
  return flush().then(() => ({
    list: els['b-list'],
    count: els['b-count'],
    filters: els['b-filters'],
    root: sandbox.document.documentElement,
    store: store,
    fetched: sandbox.fetched
  }));
}

/** Entrée `articles.json` complète, telle que le moteur la produit. */
function entry(overrides) {
  return Object.assign({
    lang: 'fr',
    slug: 'article',
    url: '/blog/fr/article.html',
    title: 'Article de test',
    excerpt: 'Extrait de test.',
    category: 'qr-code',
    date: '2026-07-14',
    readingTime: '5'
  }, overrides);
}

/** Libellés des chips de filtre, dans l'ordre rendu. */
function chipsOf(filters) {
  const out = [];
  const re = /data-cat="([^"]*)"[^>]*>([^<]*)</g;
  let m = re.exec(String(filters.innerHTML || ''));
  while (m) {
    out.push({ cat: m[1], label: m[2] });
    m = re.exec(String(filters.innerHTML || ''));
  }
  return out;
}

/* ========================================================================== */
/* Catégories dynamiques                                                       */
/* ========================================================================== */

suite('Hub — catégories dynamiques');

test('H1 : un article à catégorie INCONNUE est affiché et reçoit son filtre', () => mountHub({
  articles: [
    entry({ slug: 'garage', title: 'Menu digital pour garage', url: '/blog/fr/garage.html', category: 'garage-写字' }),
    entry({ slug: 'classique', title: 'Article QR classique', url: '/blog/fr/classique.html', category: 'qr-code' })
  ]
}).then((hub) => {
  eq(hub.fetched, '/blog/articles.json', 'source des données');

  const html = hub.list.innerHTML;
  includes(html, '/blog/fr/garage.html', 'l\'article hors liste reste dans la liste');
  includes(html, 'Menu digital pour garage', 'son titre est rendu');
  includes(html, 'garage-写字', 'son étiquette de catégorie est affichée brute');
  eq(hub.count.textContent, '2 articles', 'compteur');

  // Les filtres existent, Y COMPRIS celui de la catégorie inconnue, et les
  // catégories du site passent avant celles créées ensuite.
  const chips = chipsOf(hub.filters);
  eqListCats(chips, ['', 'qr-code', 'garage-写字'], 'filtres rendus');
  eq(chips[2].label, 'garage-写字', 'libellé brut, non traduit');
}));

test('H2 : la catégorie VIDE bascule dans « sans-categorie » sans rien cacher', () => mountHub({
  articles: [
    entry({ slug: 'sans-bucket', title: 'Article sans catégorie', url: '/blog/fr/sans-bucket.html', category: '' }),
    entry({ slug: 'qr', title: 'Article QR', url: '/blog/fr/qr.html', category: 'qr-code' })
  ]
}).then((hub) => {
  includes(hub.list.innerHTML, '/blog/fr/sans-bucket.html', 'l\'article reste listé');
  includes(hub.list.innerHTML, 'sans-categorie', 'bucket de repli affiché');
  eq(hub.count.textContent, '2 articles', 'rien n\'a disparu');
  eqListCats(chipsOf(hub.filters), ['', 'qr-code', 'sans-categorie'], 'filtres rendus');
}));

test('H3 : l\'ordre reste déterministe (date décroissante, puis slug croissant)', () => mountHub({
  articles: [
    entry({ slug: 'b-article', title: 'B', url: '/blog/fr/b.html', date: '2026-07-14' }),
    entry({ slug: 'a-article', title: 'A', url: '/blog/fr/a.html', date: '2026-07-14' }),
    entry({ slug: 'recent', title: 'Récent', url: '/blog/fr/recent.html', date: '2026-09-01' }),
    entry({ slug: 'ancien', title: 'Ancien', url: '/blog/fr/ancien.html', date: '2026-01-05' })
  ]
}).then((hub) => {
  eqListTitles(hub.list.innerHTML, ['Récent', 'A', 'B', 'Ancien'], 'ordre rendu');
}));

/* ========================================================================== */
/* Langue : filtrage strict, aucun repli                                       */
/* ========================================================================== */

suite('Hub — langue');

test('H4 : un visiteur anglophone ne voit JAMAIS un article français', () => mountHub({
  browser: 'en',
  articles: [
    entry({ lang: 'fr', slug: 'fr-article', title: 'Article français', url: '/blog/fr/fr-article.html' }),
    entry({ lang: 'en', slug: 'en-article', title: 'English article', url: '/blog/en/en-article.html', category: 'menu-digital' }),
    entry({ lang: 'ar', slug: 'ar-article', title: 'مقال عربي', url: '/blog/ar/ar-article.html' })
  ]
}).then((hub) => {
  includes(hub.list.innerHTML, '/blog/en/en-article.html', 'son article est listé');
  excludes(hub.list.innerHTML, '/blog/fr/fr-article.html', 'aucun article français');
  excludes(hub.list.innerHTML, '/blog/ar/ar-article.html', 'aucun article arabe');
  eq(hub.count.textContent, '1 article', 'compteur : un seul article');
  eq(hub.root.lang, 'en', 'documentElement.lang');
  eq(hub.root.dir, 'ltr', 'documentElement.dir');
}));

test('H5 : une langue sans aucun article affiche l\'état vide, sans repli', () => mountHub({
  search: '?lang=es',
  articles: [
    entry({ lang: 'fr', slug: 'fr-article', title: 'Article français', url: '/blog/fr/fr-article.html' })
  ]
}).then((hub) => {
  eq(hub.root.lang, 'es', 'la langue demandée par l\'URL est appliquée');
  eq(hub.root.dir, 'ltr', 'ltr pour l\'espagnol');
  eq(hub.list.children.length, 1, 'un seul nœud : l\'état vide');
  eq(hub.list.children[0].className, 'b-empty', 'classe b-empty');
  eq(hub.list.children[0].textContent, 'Todavía no hay artículos publicados en este idioma.',
    'message d\'état vide, dans la langue demandée');
  eq(hub.count.textContent, '0 artículos', 'compteur à zéro');
  eq(hub.store.i18nextLng, 'es', 'la langue est mémorisée sous la clé du site');
  eqListCats(chipsOf(hub.filters), [''], 'aucune catégorie à filtrer');
}));

test('H6 : l\'arabe passe le document en RTL', () => mountHub({
  search: '?lang=ar',
  articles: [
    entry({ lang: 'ar', slug: 'ar-article', title: 'مقال رقمي', url: '/blog/ar/ar-article.html', category: 'menu-digital' }),
    entry({ lang: 'fr', slug: 'fr-article', title: 'Article français', url: '/blog/fr/fr-article.html' })
  ]
}).then((hub) => {
  eq(hub.root.lang, 'ar', 'langue');
  eq(hub.root.dir, 'rtl', 'direction RTL');
  includes(hub.list.innerHTML, '/blog/ar/ar-article.html', 'article arabe listé');
  excludes(hub.list.innerHTML, '/blog/fr/fr-article.html', 'aucun article français');
  includes(hub.filters.innerHTML, 'قائمة رقمية', 'catégorie connue traduite en arabe');
}));

/* -------------------------------------------------------------------------- */

function eqListCats(chips, expected, label) {
  eq(JSON.stringify(chips.map((c) => c.cat)), JSON.stringify(expected), label);
}

function eqListTitles(html, expected, label) {
  const found = [];
  const re = /<h2><a href="[^"]*">([^<]*)<\/a><\/h2>/g;
  let m = re.exec(String(html));
  while (m) {
    found.push(m[1]);
    m = re.exec(String(html));
  }
  eq(JSON.stringify(found), JSON.stringify(expected), label);
}

(async function main() {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      process.stdout.write('  \u2713 ' + t.name + '\n');
    } catch (e) {
      failures.push({ suite: t.suite, name: t.name, message: e.message });
      process.stdout.write('  \u2717 ' + t.name + '\n      ' + e.message + '\n');
    }
  }

  process.stdout.write('\n');
  if (failures.length) {
    process.stdout.write('ECHEC : ' + failures.length + ' test(s) en échec, ' + passed + ' réussi(s)\n');
    failures.forEach((f) => process.stdout.write('  [' + f.suite + '] ' + f.name + '\n    ' + f.message + '\n'));
    process.exit(1);
  }
  process.stdout.write('OK : ' + passed + ' tests réussis (Hub)\n');
})();
