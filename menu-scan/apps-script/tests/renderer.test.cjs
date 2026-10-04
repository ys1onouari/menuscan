/**
 * Tests du moteur de rendu (Renderer.gs)
 * ---------------------------------------------------------------------------
 * Exécution : `node apps-script/tests/renderer.test.cjs`
 *
 * Aucun réseau, aucune écriture GitHub, aucun accès à un vrai tableur.
 * Le gabarit réel (`public/blog/template-article.html`) est utilisé tel quel :
 * aucune copie, aucune fixture de gabarit.
 *
 * Les attentes sont celles de la PRODUCTION : chemins `/blog/{LANG}/{SLUG}.html`,
 * suffixe de marque « — Blog Menu Scan », origine `https://menuscan.space`, et
 * le vocabulaire de classes du blog (`b-*`) réellement émis par le gabarit.
 */

const fs = require('fs');
const path = require('path');

const { createContext, call } = require('./harness.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'public', 'blog', 'template-article.html');
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
/** Page d'accueil : référence visuelle et structurelle du pied de page du blog. */
const SITE_HTML = path.join(REPO_ROOT, 'index.html');
const SITE = 'https://menuscan.space';
const SUFFIX = ' — Blog Menu Scan';

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
    process.stdout.write('  ✓ ' + name + '\n');
  } catch (e) {
    failures.push({ suite: currentSuite, name, message: e.message });
    process.stdout.write('  ✗ ' + name + '\n      ' + e.message + '\n');
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

function codes(result) {
  return (result.errors || []).map((e) => e.code);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Article minimal VALIDE pour le moteur de rendu.
 *
 * Les cinq champs durcis par le travail F sont Mandatory (V14 LANG, V16-V18
 * image, V19 temps de lecture) : sans eux, le moteur refuse la ligne et aucun
 * test de rendu ne pourrait distinguer une régression d'un refus de fixture.
 */
function makeArticle(overrides) {
  return Object.assign({
    ID: 'A-1',
    TITLE: 'Titre éditorial de l’article',
    SEO_TITLE: 'Titre SEO de test',
    META_DESCRIPTION: 'Description meta de test, suffisante et courte.',
    SOCIAL_DESCRIPTION: 'Description sociale de test.',
    ARTICLE_EXCERPT: 'Extrait d’article de test, très distinct.',
    CARD_EXCERPT: 'Carte de test.',
    CONTENT:
      '<h2 id="alpha">Première section</h2>\n' +
      '<p>Texte <strong>important</strong> &amp; accentué : é à ç.</p>\n' +
      '<div class="callout callout-tip"><strong>Astuce</strong> : ' +
      'vérifiez les mentions obligatoires.</div>\n' +
      '<table class="compare-table"><thead><tr><th>Cas</th><th>Consequence</th></tr></thead>' +
      '<tbody><tr><td>HT</td><td>TVA calculée</td></tr></tbody></table>\n' +
      '<h2 id="beta">Deuxième section</h2>\n' +
      '<ul><li>Point un</li><li>Point deux</li></ul>\n' +
      '<p>FIN_NON_ECHAPPE</p>',
    CATEGORY: 'guides-prix',
    SLUG: 'article-de-test',
    LANG: 'fr',
    TRANSLATION_GROUP: 'article-de-test',
    STATUS: 'PUBLISHED',
    PUBLISHED_AT: '2026-07-14',
    IMAGE_URL: '/blog/images/guides-prix.jpg',
    IMAGE_ALT: 'Illustration de l’article de test',
    IMAGE_WIDTH: '1200',
    IMAGE_HEIGHT: '630',
    READING_TIME: '6',
    ERROR: ''
  }, overrides || {});
}

/** Les 10 valeurs SEO, toutes différentes, pour prouver l'indépendance. */
function tenDistinctSeo() {
  return {
    pageTitle: 'SLOT-01-page',
    headline: 'SLOT-02-headline',
    ogTitle: 'SLOT-03-og',
    twitterTitle: 'SLOT-04-twitter',
    jsonLdHeadline: 'SLOT-05-jsonld',
    breadcrumbTitle: 'SLOT-06-breadcrumb',
    metaDescription: 'SLOT-07-meta',
    ogDescription: 'SLOT-08-ogdesc',
    twitterDescription: 'SLOT-09-twdesc',
    jsonLdDescription: 'SLOT-10-jsonlddesc',
    articleExcerpt: 'SLOT-11-excerpt'
  };
}

function render(article, options) {
  const { ctx } = createContext({});
  const opts = Object.assign({ templateHtml: TEMPLATE }, options || {});
  return call(ctx, 'renderArticleHtml', article, opts);
}

function renderOk(article, options) {
  const result = render(article, options);
  if (!result.ok) {
    throw new Error('rendu refusé : ' + JSON.stringify(codes(result)) + ' — ' +
      (result.errors || []).map((e) => e.message).join(' | '));
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 1. Les 6 catégories et le chemin {LANG}/{SLUG}                              */
/* -------------------------------------------------------------------------- */

const CATEGORIES = [
  'menu-digital', 'qr-code', 'restaurants-cafes',
  'hotels-riads', 'commerces', 'guides-prix'
];

suite('1. Catégories et chemin de publication');

CATEGORIES.forEach((slug) => {
  test('catégorie ' + slug + ' → /blog/fr/{slug}.html', () => {
    const result = renderOk(makeArticle({ CATEGORY: slug, SLUG: 'mon-article' }));
    eq(result.sitePath, '/blog/fr/mon-article.html', 'sitePath');
    eq(result.path, 'public/blog/fr/mon-article.html', 'chemin dépôt');
    eq(result.canonicalUrl, SITE + '/blog/fr/mon-article.html', 'canonicalUrl');
    contains(result.html, 'content="' + SITE + '/blog/fr/mon-article.html"', 'canonical dans le HTML');
    contains(result.html, 'data-category="' + slug + '"', 'catégorie portée par l’article');
  });
});

test('la LANGUE fait partie du chemin : deux traductions, deux fichiers', () => {
  const fr = renderOk(makeArticle({ SLUG: 'facture-tva' }));
  const es = renderOk(makeArticle({
    SLUG: 'factura-tva', LANG: 'es', TRANSLATION_GROUP: 'facture-tva',
    TITLE: 'Factura del IVA', STATUS: 'PUBLISHED'
  }));
  eq(fr.path, 'public/blog/fr/facture-tva.html', 'chemin français');
  eq(es.path, 'public/blog/es/factura-tva.html', 'chemin espagnol');
  eq(fr.sitePath, '/blog/fr/facture-tva.html', 'URL française');
  eq(es.sitePath, '/blog/es/factura-tva.html', 'URL espagnole');
  contains(es.html, '<html lang="es" dir="ltr">', 'page espagnole en LTR');
});

test('seul l’arabe est en RTL', () => {
  contains(renderOk(makeArticle()).html, '<html lang="fr" dir="ltr">', 'français en LTR');
  contains(
    renderOk(makeArticle({ LANG: 'ar', SLUG: 'facture-tva-ar', TRANSLATION_GROUP: 'facture-tva-ar' })).html,
    '<html lang="ar" dir="rtl">',
    'arabe en RTL'
  );
});

test('catégorie inconnue refusée (aucune création automatique)', () => {
  const result = render(makeArticle({ CATEGORY: 'categorie-fantome' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V3') !== -1, 'code V3 attendu, obtenu ' + JSON.stringify(codes(result)));
});

/* -------------------------------------------------------------------------- */
/* 2. Modèle SEO à 10 emplacements                                             */
/* -------------------------------------------------------------------------- */

suite('2. Les 10 champs SEO sont indépendants');

test('chaque slot atterrit sur SON site', () => {
  const h = renderOk(makeArticle(), { seo: tenDistinctSeo() }).html;

  contains(h, '<title>SLOT-01-page' + SUFFIX + '</title>', '<title> = pageTitle');
  contains(h, '<h1>SLOT-02-headline</h1>', 'h1 = headline');
  contains(h, 'property="og:title" content="SLOT-03-og"', 'og:title');
  contains(h, 'name="twitter:title" content="SLOT-04-twitter"', 'twitter:title');
  contains(h, '"headline": "SLOT-05-jsonld"', 'JSON-LD headline');
  contains(h, '<span>SLOT-06-breadcrumb</span>', 'fil d’Ariane');
  contains(h, '"name": "SLOT-06-breadcrumb"', 'JSON-LD ListItem nom');
  contains(h, 'name="description" content="SLOT-07-meta"', 'meta description');
  contains(h, 'property="og:description" content="SLOT-08-ogdesc"', 'og:description');
  contains(h, 'name="twitter:description" content="SLOT-09-twdesc"', 'twitter:description');
  contains(h, '"description": "SLOT-10-jsonlddesc"', 'JSON-LD description');
  contains(h, '<p class="article-excerpt">SLOT-11-excerpt</p>', 'extrait d’article');
});

test('aucun placeholder résiduel après rendu', () => {
  const result = renderOk(makeArticle(), { seo: tenDistinctSeo() });
  notContains(result.html, '{{', 'placeholder résiduel');
});

test('chaîne de sources : colonne dédiée > colonne secondaire', () => {
  const result = renderOk(makeArticle({ OG_TITLE: 'Titre OG dédié' }));
  contains(result.html, 'property="og:title" content="Titre OG dédié"', 'og:title depuis OG_TITLE');
  notContains(result.html, 'og:title" content="Titre SEO de test', 'pas de repli sur SEO_TITLE');
});

test('surcharge d’appel prioritaire sur la colonne', () => {
  const article = makeArticle({ META_DESCRIPTION: 'Colonne prioritaire.' });
  const h = renderOk(article, { seo: { metaDescription: 'Surcharge prioritaire.' } }).html;
  contains(h, 'name="description" content="Surcharge prioritaire."', 'surcharge appliquée');
});

test('repli déterministe documenté quand aucun slot n’est dédié', () => {
  const h = renderOk(makeArticle()).html;
  // ogTitle retombe sur SEO_TITLE…
  contains(h, 'property="og:title" content="Titre SEO de test"', 'og:title repli');
  // ogDescription retombe sur SOCIAL_DESCRIPTION
  contains(h, 'property="og:description" content="Description sociale de test."', 'og:description repli');
  // headline retombe sur TITLE
  contains(h, '<h1>Titre éditorial de l’article</h1>', 'h1 repli');
});

test('emplacement obligatoire vide : buildSeoModel le signale, le moteur refuse (V1/V4)', () => {
  const { ctx } = createContext({});
  const model = call(ctx, 'buildSeoModel', {}, {});
  ok(model.missing.indexOf('pageTitle') !== -1, 'pageTitle manquant');
  ok(model.missing.indexOf('headline') !== -1, 'headline manquant');
  ok(model.missing.indexOf('jsonLdDescription') !== -1, 'jsonLdDescription manquant');

  const result = render(makeArticle({ TITLE: '', SEO_TITLE: '' }));
  notOk(result.ok, 'rendu');
  const found = codes(result);
  ok(found.indexOf('V1') !== -1 || found.indexOf('V4') !== -1,
    'TITLE/SEO_TITLE vides refusés avant le rendu, obtenu ' + JSON.stringify(found));
});

test('garde-fou R2b : un emplacement obligatoire vide est détecté', () => {
  const { ctx } = createContext({});
  const full = call(ctx, 'buildSeoModel', makeArticle(), {});
  notOk(full.missing.length, 'modèle nominal complet');
  ok(!call(ctx, 'requiredSlotsMissing', full).length, 'aucun emplacement requis vide');

  const broken = { values: Object.assign({}, full.values) };
  delete broken.values.breadcrumbTitle;
  broken.values.metaDescription = '';
  const missing = call(ctx, 'requiredSlotsMissing', broken);
  ok(missing.indexOf('breadcrumbTitle') !== -1, 'breadcrumbTitle manquant détecté');
  ok(missing.indexOf('metaDescription') !== -1, 'metaDescription vide détecté');
  ok(missing.indexOf('pageTitle') === -1, 'pageTitle toujours présent, non signalé');
});

/* -------------------------------------------------------------------------- */
/* 3. Suffixe de marque — exactement une fois                                   */
/* -------------------------------------------------------------------------- */

suite('3. Suffixe de marque — exactement une fois');

test('suffixe ajouté au seul <title>', () => {
  const h = renderOk(makeArticle()).html;
  contains(h, '<title>Titre SEO de test' + SUFFIX + '</title>', '<title> suffixé');
  // og:title et twitter:title sont des LIBELLÉS courts : le suffixe y ferait
  //ipse du texte. Un seul site porte donc le suffixe.
  contains(h, 'property="og:title" content="Titre SEO de test"', 'og:title non suffixé');
  contains(h, 'name="twitter:title" content="Titre SEO de test"', 'twitter:title non suffixé');
  eq((h.split(SUFFIX).length - 1), 1, 'suffixe présent exactement une fois dans la page');
});

test('suffixe JAMAIS dupliqué si la valeur le porte déjà', () => {
  const already = 'Titre déjà suffixé' + SUFFIX;
  const h = renderOk(makeArticle(), { seo: { pageTitle: already, ogTitle: already } }).html;
  const title = /<title>([\s\S]*?)<\/title>/.exec(h)[1];
  eq((title.split(SUFFIX).length - 1), 1, 'occurrences dans <title>');
  eq(title, already, '<title> inchangé');
});

test('suffixe JAMAIS appliqué aux autres emplacements', () => {
  const h = renderOk(makeArticle()).html;
  ['twitter:title', 'og:description', 'twitter:description'].forEach((key) => {
    const re = new RegExp('<meta (?:name|property)="' + key + '" content="([\\s\\S]*?)"');
    const value = re.exec(h)[1];
    notContains(value, 'Blog Menu Scan', 'suffixe dans ' + key);
  });
  notContains(/<h1>([\s\S]*?)<\/h1>/.exec(h)[1], 'Blog Menu Scan', 'suffixe dans h1');
  notContains(/<p class="article-excerpt">([\s\S]*?)<\/p>/.exec(h)[1], 'Blog Menu Scan', 'suffixe dans l’extrait');
});

/* -------------------------------------------------------------------------- */
/* 4. Image de couverture : obligatoire, complète, vérifiée                     */
/* -------------------------------------------------------------------------- */

suite('4. Image de couverture (V16-V18)');

test('image complète : figure, alt, dimensions, og:image et twitter:image', () => {
  const h = renderOk(makeArticle()).html;
  contains(h, '<figure class="b-hero-img">', 'figure de couverture');
  contains(h, 'src="/blog/images/guides-prix.jpg"', 'src');
  contains(h, 'alt="Illustration de l’article de test"', 'alt accessible');
  contains(h, 'width="1200" height="630"', 'dimensions HTML, pas seulement en meta');
  contains(h, 'fetchpriority="high" decoding="async"', 'chargement prioritaire');
  contains(h, 'property="og:image" content="' + SITE + '/blog/images/guides-prix.jpg"', 'og:image absolu');
  contains(h, 'property="og:image:alt" content="Illustration de l’article de test"', 'og:image:alt');
  contains(h, 'property="og:image:width" content="1200"', 'og:image:width');
  contains(h, 'property="og:image:height" content="630"', 'og:image:height');
  contains(h, 'name="twitter:image" content="' + SITE + '/blog/images/guides-prix.jpg"', 'twitter:image');
});

test('IMAGE_URL absente ⇒ refus V16', () => {
  const result = render(makeArticle({ IMAGE_URL: '' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V16') !== -1, 'code V16 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('IMAGE_URL hors du dépôt ⇒ refus V16 (jamais d’URL relative au site)', () => {
  const result = render(makeArticle({ IMAGE_URL: 'icons/ma-vignette.png' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V16') !== -1, 'code V16 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('IMAGE_ALT absente ⇒ refus V17 (accessibilité ET og:image:alt)', () => {
  const result = render(makeArticle({ IMAGE_ALT: '' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V17') !== -1, 'code V17 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('dimensions absentes ou non entières ⇒ refus V18', () => {
  ['', 'large', '0'].forEach((bad) => {
    const result = render(makeArticle({ IMAGE_WIDTH: bad }));
    notOk(result.ok, 'rendu (width=' + JSON.stringify(bad) + ')');
    ok(codes(result).indexOf('V18') !== -1,
      'code V18 attendu pour ' + JSON.stringify(bad) + ', obtenu ' + JSON.stringify(codes(result)));
  });
});

test('LANG absente ⇒ refus V14', () => {
  const result = render(makeArticle({ LANG: '' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V14') !== -1, 'code V14 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('LANG non supportée ⇒ refus V14', () => {
  const result = render(makeArticle({ LANG: 'de' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V14') !== -1, 'code V14 attendu, obtenu ' + JSON.stringify(codes(result)));
});

/* -------------------------------------------------------------------------- */
/* 5. FAQ                                                                      */
/* -------------------------------------------------------------------------- */

const FAQ = [
  { q: 'Quel taux appliquer ?', a: 'Le taux normal de votre activité.' },
  { q: 'Et l’exonération ?', a: 'Sous conditions, avec attestation.' }
];

suite('5. FAQ');

test('FAQ présente : bloc, ancre #faq, <details> et entrée de sommaire', () => {
  const h = renderOk(makeArticle(), { faq: FAQ }).html;
  contains(h, '<div class="b-faq">', 'bloc FAQ');
  contains(h, '<h2 id="faq">Questions fréquentes</h2>', 'titre FAQ');
  contains(h, '<summary>Quel taux appliquer ?</summary>', 'question 1 en <summary>');
  contains(h, 'Sous conditions, avec attestation.', 'réponse 2 présente');
  contains(h, '<a href="#faq">Questions fréquentes</a>', 'entrée de sommaire');
});

test('FAQ absente : aucun bloc, aucun #faq, aucun lien mort', () => {
  const result = renderOk(makeArticle());
  const h = result.html;
  notContains(h, 'id="faq"', 'ancre FAQ');
  notContains(h, 'b-faq', 'bloc FAQ');
  notContains(h, 'href="#faq"', 'lien vers FAQ');
  notOk(codes(result).indexOf('V9') !== -1, 'V9 (ancre sans cible)');
});

test('FAQ vide ou sans réponse utile ⇒ aucun bloc', () => {
  notContains(renderOk(makeArticle(), { faq: [] }).html, 'b-faq', 'faq vide');
  notContains(
    renderOk(makeArticle(), { faq: [{ q: 'Question ?', a: '   ' }] }).html,
    'b-faq',
    'FAQ sans réponse'
  );
});

test('collision id="faq" dans le corps refusée', () => {
  const result = render(makeArticle({ CONTENT: '<h2 id="faq">Déjà là</h2>' }), { faq: FAQ });
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('R4a') !== -1, 'code R4a attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('intitulé de FAQ surchargeable', () => {
  const h = renderOk(makeArticle(), { faq: FAQ, faqHeading: 'Questions sur la TVA' }).html;
  contains(h, '<h2 id="faq">Questions sur la TVA</h2>', 'intitulé personnalisé');
  contains(h, '<a href="#faq">Questions sur la TVA</a>', 'sommaire aligné');
});

/* -------------------------------------------------------------------------- */
/* 6. Échappement et HTML de confiance                                         */
/* -------------------------------------------------------------------------- */

suite('6. Échappement et HTML de confiance');

test('métadonnées HTML-sensibles échappées (accent, apostrophe, esperluette)', () => {
  const seo = {
    pageTitle: 'Title & <script>',
    headline: 'L’article « test » & co',
    metaDescription: 'Des "guillemets" & un <balise>',
    articleExcerpt: 'Excerpt ‘ apostrophe ’ & <b>bold</b>'
  };
  const h = renderOk(makeArticle(), { seo }).html;

  contains(h, '<h1>L’article « test » &amp; co</h1>', 'h1 échappé');
  contains(h, 'name="description" content="Des &quot;guillemets&quot; &amp; un &lt;balise&gt;"', 'meta échappée');
  contains(h, '<p class="article-excerpt">Excerpt ‘ apostrophe ’ &amp; &lt;b&gt;bold&lt;/b&gt;</p>', 'extrait échappé');
  notContains(h, 'content="Title & <script>"', 'pageTitle non échappée');
});

test('corps de l’article : HTML de confiance, non double-échappé', () => {
  const result = renderOk(makeArticle());
  contains(result.html, '<div class="callout callout-tip">', 'encadré conservé');
  contains(result.html, '<table class="compare-table">', 'tableau conservé');
  contains(result.html, '<p>FIN_NON_ECHAPPE</p>', 'balise du corps non échappée');
  notContains(result.html, '&lt;div class="callout', 'corps échappé par erreur');
  notContains(result.html, '&amp;lt;', 'double échappement');
});

test('corps contenant un script : rendu refusé (défense en profondeur)', () => {
  const result = render(makeArticle({ CONTENT: '<p>ok</p><script>alert(1)</script>' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V21') !== -1, 'code V21 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('JSON-LD échappé en JSON, pas en HTML', () => {
  const h = renderOk(makeArticle(), {
    seo: { jsonLdHeadline: 'Titre "quoted" & <b>gras</b>' }
  }).html;
  contains(h, '\\"quoted\\"', 'guillemets échappés en JSON');
  notContains(h, '"headline": "Titre ""quoted""', 'guillemets HTML dans le JSON-LD');
  notContains(h, '&quot;quoted&quot;', 'échappement HTML appliqué au JSON-LD');
});

test('chaîne vide ne produit pas « undefined »', () => {
  const h = renderOk(makeArticle({ CARD_EXCERPT: '' })).html;
  notContains(h, 'undefined', 'undefined');
  // Le seul « null » légitime est l'idiome de préchargement Google Fonts du
  // gabarit (onload="this.onload=null") : il est retiré avant le contrôle.
  notContains(h.replace(/onload="this\.onload=null;this\.rel='stylesheet'"/g, ''), 'null', 'null');
});

/* -------------------------------------------------------------------------- */
/* 7. Sommaire                                                                 */
/* -------------------------------------------------------------------------- */

suite('7. Sommaire');

test('une entrée par titre porteur d’id, dans l’ordre', () => {
  const h = renderOk(makeArticle(), { faq: FAQ }).html;
  const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(h)[0];
  const items = toc.match(/<li><a href="#/g) || [];
  eq(items.length, 3, 'entrées de sommaire (alpha, beta, faq)');
  ok(toc.indexOf('#alpha') < toc.indexOf('#beta'), 'ordre alpha avant beta');
  ok(toc.indexOf('#beta') < toc.indexOf('#faq'), 'ordre beta avant faq');
});

test('le conteneur est exactement <nav class="toc"><ol>', () => {
  const h = renderOk(makeArticle(), { faq: FAQ }).html;
  contains(h, '<nav class="toc" aria-label="Sommaire"><ol>', 'nav.toc > ol');
});

test('un titre sans id reçoit un identifiant et alimente le sommaire', () => {
  const article = makeArticle({ CONTENT: '<h2>Sans id</h2><h2 id="oui">Avec id</h2>' });
  const h = renderOk(article).html;
  const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(h)[0];
  eq((toc.match(/<li>/g) || []).length, 2, 'une entrée par titre');
  contains(toc, '#oui', 'entrée « oui »');
  contains(toc, 'href="#sans-id"', 'l’id manquant est slugifié puis listé');
  contains(h, '<h2 id="sans-id">Sans id</h2>', 'l’id est injecté dans le corps');
  contains(h, '<h2 id="oui">Avec id</h2>', 'l’id fourni est conservé');
});

test('entités décodées dans les libellés du sommaire', () => {
  const article = makeArticle({ CONTENT: '<h2 id="x">A &amp; B &lt;c&gt;</h2>' });
  const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(renderOk(article).html)[0];
  contains(toc, '>A &amp; B &lt;c&gt;<', 'libellé échappé mais lisible');
});

/* -------------------------------------------------------------------------- */
/* 8. Blocs éditoriaux : related, pagination, temps de lecture                 */
/* -------------------------------------------------------------------------- */

suite('8. Blocs éditoriaux');

test('related : une liste de liens, un résumé quand il existe', () => {
  const h = renderOk(makeArticle(), {
    related: [
      { title: 'Article lié', path: 'blog/fr/autre-article.html', excerpt: 'Résumé court.' },
      { title: 'Sans résumé', path: '/blog/fr/sans-resume.html' }
    ]
  }).html;
  contains(h, '<div class="b-related">', 'bloc related');
  contains(h, '<a href="/blog/fr/autre-article.html">Article lié</a>', 'lien 1');
  contains(h, '<a href="/blog/fr/sans-resume.html">Sans résumé</a>', 'lien 2');
});

test('related vide ⇒ aucun conteneur vide', () => {
  const h = renderOk(makeArticle()).html;
  notContains(h, 'b-related', 'aucun bloc related sans donnée');
  notContains(h, '<ul>\n    </ul>', 'liste vide');
  notContains(h, '<p></p>', 'paragraphe vide');
});

test('pagination : libellés génériques et titre de l’article', () => {
  const h = renderOk(makeArticle(), {
    previous: { title: 'Article précédent', path: 'blog/fr/x.html' },
    next: { title: 'Article suivant', path: 'blog/fr/y.html' }
  }).html;
  const pager = /<nav class="b-pager"[\s\S]*?<\/nav>/.exec(h)[0];
  contains(pager, '<a href="/blog/fr/x.html">', 'lien précédent');
  contains(pager, '<span class="b-pager-kind">Article précédent</span>', 'libellé précédent');
  contains(pager, '<span class="b-pager-title">Article précédent</span>', 'titre précédent');
  contains(pager, '<span class="b-pager-kind">Article suivant</span>', 'libellé suivant');
  contains(pager, '<span class="b-pager-title">Article suivant</span>', 'titre suivant');
});

test('voisin absent ⇒ slot vide, pas de lien cassé', () => {
  const pager = /<nav class="b-pager"[\s\S]*?<\/nav>/.exec(renderOk(makeArticle()).html)[0];
  notContains(pager, '<a', 'lien résiduel');
  notContains(pager, 'Article précédent', 'libellé orphelin');
  notContains(pager, 'Article suivant', 'libellé orphelin');
});

test('origine étrangère refusée dans les liens', () => {
  const h = renderOk(makeArticle(), {
    next: { title: 'Pirate', path: 'https://evil.example/blog/fr/x.html' }
  }).html;
  notContains(h, 'evil.example', 'origine étrangère');
  notContains(h, 'Pirate', 'voisin rejeté');
});

test('temps de lecture : valeur éditoriale, jamais recalculée', () => {
  const h = renderOk(makeArticle({ READING_TIME: '9' })).html;
  contains(h, '<span>9&nbsp;min</span>', 'temps de lecture éditorial');
  notContains(h, '1&nbsp;min', 'pas de valeur recalculée');
});

test('temps de lecture absent ⇒ refus V19 (jamais de calcul de repli)', () => {
  const result = render(makeArticle({ READING_TIME: '' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('V19') !== -1, 'code V19 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('temps de lecture « 8 » normalisé, pas de doublon d’unité', () => {
  const h = renderOk(makeArticle({ READING_TIME: '8' })).html;
  contains(h, '<span>8&nbsp;min</span>', 'normalisation');
  notContains(h, 'min&nbsp;min', 'doublon d’unité');
});

/* -------------------------------------------------------------------------- */
/* 9. Post-traitement de production                                            */
/* -------------------------------------------------------------------------- */

suite('9. Post-traitement de production');

test('règle 2 : les assets du blog sont en profondeur 1, ceux du site en absolu', () => {
  const h = renderOk(makeArticle()).html;
  // Un article vit dans /blog/{lang}/ : UN SEUL niveau vers public/blog.
  contains(h, 'href="../assets/blog.css"', 'CSS du blog en profondeur 1');
  notContains(h, '../../', 'aucun asset en profondeur 2');
  notContains(h, '"../css/', 'ancien site introuvable');
  // Les assets du site principal ne doivent jamais être réécrits.
  contains(h, 'href="/apple-touch-icon.png"', 'asset du site en absolu');
  contains(h, 'href="data:image/svg+xml', 'favicon en data: URI, non réécrit');
});

test('règle 2 : une profondeur 0 résiduelle est rejetée', () => {
  const h = renderOk(makeArticle()).html.replace('"../assets/blog.css"', '"assets/blog.css"');
  const { ctx } = createContext({});
  const v = call(ctx, 'validateRenderedHtml', h, { canonicalPath: '/blog/fr/article-de-test.html' });
  notOk(v.ok, 'validation');
  ok(v.errors.some((e) => e.code === 'P2'), 'code P2 attendu, obtenu ' + JSON.stringify(v.errors.map((e) => e.code)));
});

test('règle 3 : robots basculés, noindex absent', () => {
  const h = renderOk(makeArticle()).html;
  contains(h, '<meta name="robots" content="index, follow">', 'robots production');
  notContains(h, 'noindex', 'noindex résiduel');
});

test('règle 3 : sortie sans bascule ⇒ P1', () => {
  const raw = TEMPLATE.replace(/<!--[\s\S]*?-->/g, '');
  const { ctx } = createContext({});
  const v = call(ctx, 'validateRenderedHtml', raw, { canonicalPath: '/blog/fr/x.html' });
  notOk(v.ok, 'validation');
  ok(v.errors.some((e) => e.code === 'P1'), 'code P1 attendu');
  ok(v.errors.some((e) => e.code === 'P1b'), 'code P1b attendu');
});

test('règle 4 : le commentaire de gabarit est CONSERVÉ mais reste inerte', () => {
  const h = renderOk(makeArticle()).html;
  // Le gabarit l'exige : le commentaire vit dans la page publiée. Il ne doit
  // contenir NI placeholder (le moteur le破了ait) NI balise d'ancrage (le
  // compteur de sites s'en servirait pour se tromper).
  const comments = h.match(/<!--[\s\S]*?-->/g) || [];
  const doc = comments.filter((c) => c.indexOf('TEMPLATE D\'ARTICLE') !== -1)[0] || '';
  ok(doc, 'commentaire de gabarit conservé dans la page publiée');
  notContains(doc, '{{', 'aucun placeholder dans le commentaire');
  notContains(doc, '<a ', 'aucune balise d\'ancrage dans le commentaire');
  notContains(doc, '<span', 'aucune balise <span> dans le commentaire');
});

test('règle 5 : retour hub, fil d’Ariane et pied de page intacts', () => {
  const h = renderOk(makeArticle()).html;
  contains(h, '<p><a class="b-back" href="/blog/">', 'retour hub');
  contains(h, '<p class="b-crumb">\n        <a href="/blog/">Blog</a>', 'fil d’Ariane vers le hub');
  contains(h, '<a class="b-nav-blog" href="/blog/">Blog</a>', 'entrée blog de la navigation');
  contains(h, '<a class="b-btn b-btn-ghost" href="/blog/">Voir tous les articles</a>', 'CTA vers le hub');
  const footer = /<footer[\s\S]*?<\/footer>/.exec(h)[0];
  contains(footer, '<div class="f-logo">', 'logo du pied de page');
  contains(footer, '<div class="f-links">', 'bloc de liens du pied de page');
  contains(footer, '<a href="/blog/" data-i18n="footer.blog">Blog</a>', 'lien Blog');
  contains(footer, 'data-i18n="footer.contact">Contact</a>', 'lien Contact');
  contains(footer, 'data-i18n="footer.instagram">Instagram</a>', 'lien Instagram');
  contains(footer, 'data-i18n="footer.copyrightLinkText">AKKOUS</a>', 'crédit AKKOUS');
  contains(footer, 'Menu Scan', 'signature de marque');
  notContains(footer, 'b-foot', 'plus aucune classe de l’ancien pied de page');
  notContains(footer, 'Accueil', 'plus aucun lien Accueil (le nouveau footer est celui d’index.html)');
});

test('règle 5 : le pied de page localise ses cinq libellés', () => {
  ['fr', 'en', 'es', 'ar'].forEach((lang) => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(renderOk(makeArticle({ LANG: lang })).html)[0];
    notContains(footer, '{{', 'aucun placeholder résiduel (' + lang + ')');
    // Une valeur absente se lirait comme un trou : le copyright est le témoin.
    ok(/data-i18n="footer\.copyright">[^<]+<\/span>/.test(footer),
      'copyright rendu en ' + lang);
    ok(/data-i18n="footer\.blog">[^<]+<\/a>/.test(footer),
      'lien Blog rendu en ' + lang);
  });
});

/**
 * Le pied de page est celui de `index.html`, référence visuelle et structurelle :
 * l'inventaire de ses liens est donc un contrat, pas une approximation. L'ancien
 * footer interdisait le lien vers le hub ; le footer de `index.html` en contient
 * UN, à côté du contact et d'Instagram. Le test vérifie l'inventaire complet —
 * plus fort que l'ancien « aucun lien », car il détecte toute dérive.
 *
 * Le compte est tiré de `index.html` lui-même : si le footer de référence change,
 * ce test doit changer avec lui.
 */
test('règle 5 : le pied de page est celui d’index.html, liens compris', () => {
  const footer = /<footer[\s\S]*?<\/footer>/.exec(renderOk(makeArticle()).html)[0];

  const ref = /<footer[\s\S]*?<\/footer>/.exec(fs.readFileSync(SITE_HTML, 'utf8'))[0];
  const links = (s) => (s.match(/<a\b/g) || []).length;
  const hubLinks = (s) => (s.match(/href="\/blog\/"/g) || []).length;

  eq(links(footer), links(ref), 'nombre de liens identique à index.html (' + links(ref) + ')');
  eq(hubLinks(footer), hubLinks(ref),
    'exactement ' + hubLinks(ref) + ' lien vers le hub, comme index.html');
  eq((footer.match(/<nav\b/g) || []).length, 0,
    'aucun <nav> : le nouveau footer n’a pas d’étiquette aria à traduire');

  // Chaque lien du footer de référence doit se retrouver à l'identique.
  ['href="https://wa.me/212630230803"', 'href="https://www.instagram.com/onouari"',
    'class="f-credit"'].forEach((frag) => contains(footer, frag, 'fragment du footer de référence : ' + frag));
});

test('le gabarit n’est jamais modifié sur disque', () => {
  eq(fs.readFileSync(TEMPLATE_PATH, 'utf8'), TEMPLATE, 'gabarit inchangé');
  contains(TEMPLATE, 'noindex, nofollow', 'gabarit toujours noindex');
  contains(TEMPLATE, '"assets/blog.css"', 'gabarit toujours en profondeur 0 (le moteur ajoute le préfixe)');
});

/* -------------------------------------------------------------------------- */
/* 10. Contrats d’erreur du moteur                                             */
/* -------------------------------------------------------------------------- */

suite('10. Contrats d’erreur du moteur');

test('gabarit manquant ⇒ erreur', () => {
  const { ctx } = createContext({});
  const result = call(ctx, 'renderArticleHtml', makeArticle(), {});
  notOk(result.ok, 'rendu');
  eq(codes(result)[0], 'R0', 'code R0, obtenu ' + JSON.stringify(codes(result)));
});

test('ligne non publiable ⇒ R0 (READY, ERROR, DRAFT…)', () => {
  ['READY', 'ERROR', 'DRAFT'].forEach((status) => {
    const result = render(makeArticle({ STATUS: status }));
    notOk(result.ok, 'rendu (status=' + status + ')');
    ok(codes(result).indexOf('R0') !== -1,
      'code R0 attendu pour ' + status + ', obtenu ' + JSON.stringify(codes(result)));
  });
});

test('PUBLISHING est rendu : le Publisher bascule avant d’écrire', () => {
  const result = render(makeArticle({ STATUS: 'PUBLISHING' }));
  ok(result.ok, 'PUBLISHING rendu : ' + JSON.stringify(codes(result)));
});

test('gabarit avec placeholder hors contrat ⇒ refus T2b nommant le token', () => {
  const { ctx } = createContext({});
  const leaky = TEMPLATE.replace('{{READING_TIME}}', '{{READING_TIME}} {{UNKNOWN_TOKEN}}');
  const result = call(ctx, 'renderArticleHtml', makeArticle(), { templateHtml: leaky });
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('T2b') !== -1, 'code T2b attendu, obtenu ' + JSON.stringify(codes(result)));
  contains(JSON.stringify(result.errors), 'UNKNOWN_TOKEN', 'token fautif nommé');
});

test('gabarit dont un {{TITLE}} est figé ⇒ refus T2c (7 occurrences attendues)', () => {
  const { ctx } = createContext({});
  const frozen = TEMPLATE.replace('<title>{{TITLE}}</title>', '<title>Titre fige</title>');
  const result = call(ctx, 'renderArticleHtml', makeArticle(), { templateHtml: frozen });
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('T2c') !== -1, 'code T2c attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('gabarit dont un site TITLE dérive ⇒ refus (site non reconnu)', () => {
  const { ctx } = createContext({});
  const drifted = TEMPLATE.replace('<h1>{{TITLE}}</h1>', '<h1 class="x">{{TITLE}}</h1>');
  const result = call(ctx, 'renderArticleHtml', makeArticle(), { templateHtml: drifted });
  notOk(result.ok, 'rendu');
  const found = codes(result);
  ok(found.indexOf('V10') !== -1 || found.indexOf('R5') !== -1 || found.indexOf('R5b') !== -1,
    'code V10/R5/R5b attendu, obtenu ' + JSON.stringify(found));
});

test('le gabarit ne porte aucun suffixe de marque : il est injecté par le moteur', () => {
  eq(/<title>[^<]*<\/title>/.exec(TEMPLATE)[0], '<title>{{TITLE}}</title>', 'gabarit minimal');
  const h = renderOk(makeArticle()).html;
  const occurrences = h.split(' — Blog Menu Scan').length - 1;
  eq(occurrences, 1, 'une seule occurrence du suffixe dans la sortie');
  contains(h, '<title>Titre SEO de test — Blog Menu Scan</title>', 'suffixe sur le seul <title>');
});

test('gabarit dont le préfixe de profondeur est déjà écrit ⇒ refus T7', () => {
  const { ctx } = createContext({});
  const prefixed = TEMPLATE.replace('"assets/blog.css"', '"../assets/blog.css"');
  const result = call(ctx, 'renderArticleHtml', makeArticle(), { templateHtml: prefixed });
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('T7') !== -1, 'code T7 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('gabarit dont le conteneur du sommaire a muté ⇒ refus T6', () => {
  const { ctx } = createContext({});
  const mutated = TEMPLATE.replace('<nav class="toc" aria-label="{{TOC_HEADING}}"><ol>', '<div class="toc"><ol>');
  const result = call(ctx, 'renderArticleHtml', makeArticle(), { templateHtml: mutated });
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('T6') !== -1, 'code T6 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('canonical absent ⇒ V11a', () => {
  const { ctx } = createContext({});
  const h = renderOk(makeArticle()).html.replace(/<link rel="canonical"[^>]*>/, '');
  const v = call(ctx, 'validateRenderedHtml', h, { canonicalPath: '/blog/fr/article-de-test.html' });
  notOk(v.ok, 'validation');
  ok(v.errors.some((e) => e.code === 'V11a'), 'code V11a attendu');
});

test('canonical vers une autre URL ⇒ V11', () => {
  const { ctx } = createContext({});
  const h = renderOk(makeArticle()).html.replace(
    SITE + '/blog/fr/article-de-test.html"',
    SITE + '/blog/fr/autre.html"'
  );
  const v = call(ctx, 'validateRenderedHtml', h, { canonicalPath: '/blog/fr/article-de-test.html' });
  notOk(v.ok, 'validation');
  ok(v.errors.some((e) => e.code === 'V11'), 'code V11 attendu');
});

test('PUBLISHED_AT invalide ⇒ R3a', () => {
  const result = render(makeArticle({ PUBLISHED_AT: '14/07/2026' }));
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('R3a') !== -1, 'code R3a attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('catégorie résolue par table explicite, jamais par slugify', () => {
  const { ctx } = createContext({});
  eq(call(ctx, 'blogPath', 'fr', 'mon-article'), 'public/blog/fr/mon-article.html', 'blogPath');
  eq(call(ctx, 'sitePath', 'fr', 'mon-article'), '/blog/fr/mon-article.html', 'sitePath');
  // La catégorie ne fait PLUS partie du chemin : elle ne sert qu'au tri.
  eq(call(ctx, 'resolveCategory', 'guides-prix').slug, 'guides-prix', 'resolveCategory');
  notContains(call(ctx, 'sitePath', 'fr', 'mon-article'), 'guides-prix',
    'la catégorie n’est jamais dans l’URL');
});

/* -------------------------------------------------------------------------- */
/* 11. Fidélité au socle de production                                         */
/* -------------------------------------------------------------------------- */

suite('11. Fidélité au socle de production');

const INDEX_JSON = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'public', 'blog', 'articles.json'), 'utf8')
);

test('articles.json : schéma et fichiers réellement présents', () => {
  ok(Array.isArray(INDEX_JSON.articles), 'liste d’articles');
  ok(INDEX_JSON.articles.length > 0, 'au moins un article publié');
  INDEX_JSON.articles.forEach((entry) => {
    eq(typeof entry.lang, 'string', 'lang');
    eq(entry.url, '/blog/' + entry.lang + '/' + entry.slug + '.html', 'url canonique de ' + entry.slug);
    ok(entry.image.indexOf('/blog/images/') === 0, 'image sous /blog/images/ : ' + entry.image);
    ok(fs.existsSync(path.join(REPO_ROOT, 'public', entry.url.replace(/^\//, ''))),
      'fichier publié présent : ' + entry.url);
  });
});

test('les hreflang d’un article publié sont réciproques', () => {
  const entry = INDEX_JSON.articles[0];
  const file = path.join(REPO_ROOT, 'public', entry.url.replace(/^\//, ''));
  const html = fs.readFileSync(file, 'utf8');
  const links = (html.match(/<link rel="alternate" hreflang="[^"]+" href="[^"]+">/g) || []);
  const group = INDEX_JSON.articles.filter((a) => a.translationGroup === entry.translationGroup);
  group.forEach((sibling) => {
    ok(links.some((l) => l.indexOf('hreflang="' + sibling.lang + '"') !== -1 &&
      l.indexOf('href="' + SITE + sibling.url + '"') !== -1),
      'lien vers ' + sibling.lang + ' dans ' + entry.url);
  });
  // La réciprocité : chaque sœur cite l'autre.
  if (group.length > 1) {
    const other = group.filter((g) => g.url !== entry.url)[0];
    const otherHtml = fs.readFileSync(
      path.join(REPO_ROOT, 'public', other.url.replace(/^\//, '')), 'utf8');
    contains(otherHtml, 'href="' + SITE + entry.url + '"', 'la sœur cite ' + entry.url);
  }
});

test('sortie : mêmes invariants structurels que la production', () => {
  const h = renderOk(makeArticle({ SLUG: 'menu-digital-qr-code-restaurant-maroc' }), {
    faq: FAQ,
    related: [{ title: 'Autre article', path: 'blog/fr/autre.html', excerpt: 'Résumé.' }],
    previous: { title: 'Précédent', path: 'blog/fr/x.html' },
    next: { title: 'Suivant', path: 'blog/fr/y.html' }
  }).html;

  // Vocabulaire de classes réellement émis par le gabarit de production.
  ['b-crumb', 'b-toc-heading', 'toc', 'b-meta', 'b-hero-img', 'article-excerpt',
    'b-body', 'b-faq', 'b-cta', 'b-related', 'b-pager', 'b-back', 'f-inner'
  ].forEach((c) => contains(h, c, 'classe de production « ' + c + ' »'));
  contains(h, '<meta name="robots" content="index, follow">', 'robots production');
  contains(h, 'property="og:image" content="https://menuscan.space/blog/images/', 'og:image du site');
  contains(h, 'hreflang="fr"', 'hreflang fr');
  contains(h, 'hreflang="x-default"', 'hreflang x-default');
  contains(h, '"@type": "Article"', 'JSON-LD Article');
  contains(h, '"@type": "BreadcrumbList"', 'JSON-LD BreadcrumbList');
  contains(h, '"inLanguage": "fr"', 'inLanguage');
  contains(h, '"publisher"', 'publisher JSON-LD');
  notContains(h, '{{', 'aucun placeholder');
});

test('JSON-LD : UN bloc @graph parsable, deux nœuds', () => {
  const h = renderOk(makeArticle(), { faq: FAQ }).html;
  const blocks = h.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
  eq(blocks.length, 1, 'un seul bloc JSON-LD');
  const graph = JSON.parse(blocks[0].replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
  eq(graph['@graph'].length, 2, 'deux nœuds dans le graphe');
  graph['@graph'].forEach((node) => ok(node['@type'], 'type du nœud ' + node['@type']));
});

test('validation du rendu : aucune erreur sur la sortie nominale', () => {
  const result = renderOk(makeArticle(), { faq: FAQ });
  ok(result.validation, 'rapport de validation présent');
  ok(result.validation.ok, 'validation verte : ' + JSON.stringify(result.validation.errors || []));
  eq(result.validation.errors.length, 0, 'zéro erreur');
});

test('aucune écriture GitHub ni appel réseau pendant le rendu', () => {
  let fetchCalls = 0;
  const { ctx } = createContext({
    fetchImpl: { fetch: () => { fetchCalls += 1; throw new Error('réseau interdit'); } }
  });
  const result = call(ctx, 'renderArticleHtml', makeArticle(), { templateHtml: TEMPLATE });
  ok(result.ok, 'rendu : ' + JSON.stringify(codes(result)));
  eq(fetchCalls, 0, 'appels UrlFetch');
});

test('validateRenderedHtml est appelé par le moteur et verrouille le résultat', () => {
  // Une ancre morte dans le corps ne peut PAS être réparée par le
  // post-traitement : seul le contrôle V9 peut la refuser.
  const result = render(makeArticle({
    CONTENT: '<h2 id="alpha">A</h2><a href="#fantome">lien mort</a>'
  }));
  notOk(result.ok, 'rendu');
  ok(result.validation, 'rapport de validation présent');
  ok(codes(result).indexOf('V9') !== -1, 'code V9 attendu, obtenu ' + JSON.stringify(codes(result)));
});

test('un gabarit dont les robots ne sont pas « noindex, nofollow » est refusé', () => {
  const { ctx } = createContext({});
  const result = call(ctx, 'renderArticleHtml', makeArticle(), {
    templateHtml: TEMPLATE.replace('noindex, nofollow', 'index, follow')
  });
  notOk(result.ok, 'rendu');
  ok(codes(result).indexOf('T3') !== -1, 'code T3 attendu, obtenu ' + JSON.stringify(codes(result)));
});

/* -------------------------------------------------------------------------- */

process.stdout.write('\n');
if (failures.length) {
  process.stdout.write('ÉCHEC : ' + failures.length + ' test(s) en échec, ' + passed + ' réussi(s)\n');
  failures.forEach((f) => process.stdout.write('  [' + f.suite + '] ' + f.name + '\n    ' + f.message + '\n'));
  process.exitCode = 1;
} else {
  process.stdout.write('OK : ' + passed + ' tests réussis (Renderer)\n');
}
