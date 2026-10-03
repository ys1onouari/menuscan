/**
 * Menu Scan — Publication automatisée du Blog
 * Module : BlogIndexes.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : RÉCONCILIER les index statiques du Blog après
 * l'écriture d'un article, afin qu'un article publié soit immédiatement
 * visible dans sa page de catégorie, dans le hub Blog et dans le sitemap.
 *
 * Principes ( conformity stricte à l'existant ) :
 *   - PATCH déterministe, JAMAIS régénération. L'ordre éditorial des 9
 *     articles existants n'est PAS dérivable des données (la page
 *     Facturation mélange 8 min, 6 min puis 7 min à date identique) : le
 *     régénérer le détruirait. On ne touche donc qu'à la seule entrée qui
 *     nous concerne.
 *   - AUCUNE modification des fichiers du dépôt depuis Apps Script en dehors
 *     des 4 fichiers d'index ; le HTML de production est lu tel quel et
 *     réécrit octet pour octet, sauf l'entrée concernée.
 *   - AUCUNE bibliothèque de parsing HTML : Apps Script n'en fournit pas et
 *     le dépôt n'en dépend pas. Ciblage par motifs ancrés et bornés.
 *   - AUCUN changement d'architecture : réutilisation de escHtml(),
 *     frenchDate(), normalizeReadingTime(), sitePath(), getCategoryMap(),
 *     getFile(), createOrUpdate(), logWarning().
 *   - Le retry sur conflit de SHA est fait EN LIGNE dans
 *     upsertArticleInIndexFile() et NON via retryAfterConflict() (helper de
 *     Publisher.gs) : il faut aussi recalculer le compteur sur le contenu
 *     relu, ce que le helper partagé ne permet pas. createOrUpdate() reste
 *     utilisé pour l'écriture, donc le verrou assertWritesAllowed() s'applique
 *     exactement comme pour l'article.
 *   - SÉQUENCE FIXE : articles.json → sitemap. Ce Blog n'a aucun index de
 *     catégorie et son hub est dynamique : ni l'un ni l'autre ne porte
 *     d'écriture.
 *     `articles.json` passe AVANT le sitemap parce que c'est la source de vérité
 *     du hub public : un sitemap en retard ne se voit pas, une liste d'articles
 *     sans le nouvel article, si.
 *
 * Idempotence : la réconciliation est relisible et réinsérable. Republier un
 * article déjà présent ne produit aucun changement, donc aucune écriture.
 */

/**
 * Hub du Blog.
 *
 * Littéral, et NON `APP.HUB_PATH` : cette variable de module est initialisée au
 * chargement du fichier, alors que `BlogIndexes.gs` précède `Utils.gs` — une
 * dépendance à l'ordre de chargement donnerait `undefined` pour toute la
 * session. Les deux valeurs sont identiques et le harnais de tests le vérifie.
 */
var BLOG_HUB_PATH = 'public/blog/index.html';
var BLOG_LIST_OPEN = '<ul class="article-list">';
var BLOG_ITEM_OPEN = '<li class="article-item">';
var BLOG_CARD_OPEN = '<div class="cat-card">';
var ARTICLE_ITEM_RE = /<li class="article-item">[\s\S]*?<\/li>/g;

/* ------------------------------------------------------------------------ */
/* Carte d'article                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Excerpt de carte : même chaîne de repli que le moteur SEO
 * (SEO_SLOT_SOURCES.articleExcerpt), afin qu'une carte et une balise
 * og:description ne divergent pas silencieusement. Jamais recalculé.
 */
function indexCardExcerpt(article) {
  var chain = ['ARTICLE_EXCERPT', 'META_DESCRIPTION'];
  for (var i = 0; i < chain.length; i++) {
    var candidate = String(
      article[chain[i]] === null || article[chain[i]] === undefined ? '' : article[chain[i]]
    ).trim();
    if (candidate) return candidate;
  }
  return '';
}

/**
 * Une carte d'index, au markup EXACT déjà en production.
 *
 * Hub        : <div class="meta">{Catégorie} · {date} · {N} min</div>
 * Catégorie  : <div class="meta">{date} · {N} min</div>
 *
 * Le temps de lecture est ÉDITORIAL (colonne READING_TIME) : il n'est jamais
 * recalculé, conformément à la décision PO-2 du moteur de rendu.
 *
 * @param {Object} article ligne `Articles`
 * @param {{withCategory?:boolean, sitePath?:string}} [options]
 *        `sitePath` permet au Publisher de réinjecter le chemin calculé par
 *        renderArticleHtml(), garantissant que la carte pointe exactement sur
 *        le fichier publié.
 * @return {{ok:boolean, html?:string, href?:string, error?:string}}
 */
function buildArticleListItem(article, options) {
  var opt = options || {};
  var withCategory = opt.withCategory !== false;

  var title = String(article && article.TITLE ? article.TITLE : '').trim();
  if (!title) {
    return { ok: false, error: 'TITLE absent : impossible de fabriquer une carte d’index.' };
  }

  var slug = String(article && article.SLUG ? article.SLUG : '').trim();
  if (!slug) {
    return { ok: false, error: 'SLUG absent : impossible de fabriquer une carte d’index.' };
  }

  // Le segment de chemin est la LANGUE, jamais la catégorie : les fichiers
  // publiés sont `blog/{lang}/{slug}.html` (voir blogPath()/sitePath()), et les
  // index de catégorie n'existent pas sur ce site. Sans LANG lisible, on
  // refuse plutôt que de fabriquer un href `//`.
  var lang = String(article && article.LANG ? article.LANG : '').trim();
  if (!isSupportedLang(lang)) {
    return {
      ok: false,
      error: 'LANG absente ou non gérée pour l’index : « ' + lang + ' ».'
    };
  }

  var categoryName = String(article && article.CATEGORY ? article.CATEGORY : '').trim();
  var map = getCategoryMap();
  var categorySlug = String(map[categoryName] === undefined ? '' : map[categoryName]).trim();
  if (!categorySlug) {
    return {
      ok: false,
      error: 'Catégorie inconnue pour l’index : « ' + categoryName + ' ».'
    };
  }

  var reading = normalizeReadingTime(article.READING_TIME);
  if (reading.error) return { ok: false, error: reading.error };

  var date = frenchDate(String(article.PUBLISHED_AT || '').trim());
  if (!date) {
    return {
      ok: false,
      error: 'PUBLISHED_AT illisible : « ' + article.PUBLISHED_AT + ' » (attendu YYYY-MM-DD).'
    };
  }

  var href = opt.sitePath ? opt.sitePath : sitePath(lang, slug);
  if (href.charAt(0) !== '/') href = '/' + href;

  var meta = date + ' · ' + reading.value + ' min';
  if (withCategory) meta = categoryName + ' · ' + meta;

  var html = BLOG_ITEM_OPEN +
    '<div class="meta">' + escHtml(meta) + '</div>' +
    '<h3><a href="' + escHtml(href) + '">' + escHtml(title) + '</a></h3>' +
    '<p>' + escHtml(indexCardExcerpt(article)) + '</p>' +
    '</li>';

  return { ok: true, html: html, href: href, lang: lang, categorySlug: categorySlug };
}

/* ------------------------------------------------------------------------ */
/* Insertion dans une liste d'articles                                        */
/* ------------------------------------------------------------------------ */

/**
 * Insère ou remplace une carte dans le `<ul class="article-list">` existant.
 *
 * Fonction PUR : ne lit ni n'écrit GitHub. Cible la liste existante et ne
 * modifie rien en dehors. L'identification d'un article déjà listé se fait par
 * son href EXACT, ce qui garantit l'absence de doublon.
 *
 * L'ordre éditorial est préservé : seul l'article concerné est déplacé, les
 * autres entrées ne bougent pas. Un nouvel article est inséré en tête (ordre
 * « Derniers articles »).
 *
 * @param {string} html page d'index existante
 * @param {{html:string, href:string}} item sortie de buildArticleListItem()
 * @return {{ok:boolean, html?:string, action?:string, error?:string}}
 */
function upsertArticleInList(html, item) {
  var source = String(html || '');
  var openIdx = source.indexOf(BLOG_LIST_OPEN);
  if (openIdx === -1) {
    return {
      ok: false,
      error: 'Liste d’articles absente : ' + BLOG_LIST_OPEN + ' introuvable.'
    };
  }
  var bodyStart = openIdx + BLOG_LIST_OPEN.length;
  var closeIdx = source.indexOf('</ul>', bodyStart);
  if (closeIdx === -1) {
    return { ok: false, error: 'Liste d’articles non fermée : </ul> introuvable.' };
  }

  var body = source.slice(bodyStart, closeIdx);
  var needle = 'href="' + item.href + '"';

  // 1) l'article est déjà listé → remplacement de SON entrée uniquement.
  ARTICLE_ITEM_RE.lastIndex = 0;
  var existing = null;
  var m;
  while ((m = ARTICLE_ITEM_RE.exec(body)) !== null) {
    if (m[0].indexOf(needle) !== -1) {
      existing = m;
      break;
    }
  }
  if (existing) {
    return {
      ok: true,
      action: 'replaced',
      html: source.slice(0, bodyStart) +
        body.slice(0, existing.index) + item.html + body.slice(existing.index + existing[0].length) +
        source.slice(closeIdx)
    };
  }

  // 2) article absent → insertion en tête, en réutilisant la séparation et
  //    l'indentation déjà présentes dans la liste.
  var firstIdx = body.indexOf(BLOG_ITEM_OPEN);
  if (firstIdx === -1) {
    return {
      ok: true,
      action: 'inserted',
      html: source.slice(0, bodyStart) + item.html + body + source.slice(closeIdx)
    };
  }
  var sep = body.slice(0, firstIdx);
  return {
    ok: true,
    action: 'inserted',
    html: source.slice(0, bodyStart) +
      body.slice(0, firstIdx) + item.html + sep + body.slice(firstIdx) +
      source.slice(closeIdx)
  };
}

/* ------------------------------------------------------------------------ */
/* Écriture d'un fichier d'index (idempotente)                                */
/* ------------------------------------------------------------------------ */

/**
 * Lit un fichier d'index, applique upsertArticleInList(), réécrit UNIQUEMENT
 * si le contenu a réellement changé.
 *
 * createOrUpdate() réutilise createOrUpdateFile(), donc TOUJOURS le verrou
 * assertWritesAllowed() : aucun contournement possible de TEST_MODE ni de
 * GITHUB_WRITE_ENABLED. Le message de commit est déterministe.
 *
 * @param {string} path chemin du fichier d'index (ex. blog/tva/index.html)
 * @param {{html:string, href:string}} item sortie de buildArticleListItem()
 * @param {Object} [meta] { message, action, allowAbsent } trace lisible du
 *        commit ; `allowAbsent` transforme l'index manquant en étape sautée
 *        (`absent`) au lieu d'une erreur — voir updateIndexesForArticle().
 * @return {{ok:boolean, action?:string, path?:string, changed?:boolean,
 *           sha?:string, count?:number, absent?:boolean, error?:string}}
 */
function upsertArticleInIndexFile(path, item, meta) {
  var info = meta || {};
  var existing;
  try {
    existing = getFile(path);
  } catch (e) {
    return { ok: false, error: 'Lecture impossible de ' + path + ' : ' + redact(String(e && e.message ? e.message : e)) };
  }
  if (!existing) {
    // Ce Blog n'a AUCUN index de catégorie : rien à réconcilier, donc rien à
    // signaler comme défaut. `allowAbsent` n'est utilisé que par le
    // Publisher, jamais par un appel direct.
    if (info.allowAbsent) {
      return { ok: true, action: 'absent', path: path, changed: false, absent: true, count: 0 };
    }
    return {
      ok: false,
      error: 'Index absent du dépôt : ' + path +
        '. L’index doit exister avant publication (aucune création automatique).'
    };
  }

  var patched = upsertArticleInList(existing.content, item);
  if (!patched.ok) return { ok: false, error: path + ' : ' + patched.error };

  // Nombre RÉEL d'entrées de la liste patchée : c'est la source de vérité du
  // compteur du hub, et non un durcissage ni le total du hub (qui ne liste
  // qu'une sélection d'articles). Calculé sur le contenu déjà patché, donc
  // sans lecture GitHub supplémentaire.
  var count = (patched.html.match(/<li class="article-item">/g) || []).length;

  // Aucun changement → aucune écriture, aucun commit. C'est ce qui rend la
  // republication silencieuse et le double-clic opérateur sans effet.
  if (patched.html === existing.content) {
    return {
      ok: true,
      action: 'unchanged',
      path: path,
      changed: false,
      sha: existing.sha,
      count: count
    };
  }

  var message = info.message || ('Index : ajout de ' + (item.href || ''));
  try {
    var written = createOrUpdate({
      path: path,
      content: patched.html,
      message: message,
      sha: existing.sha,
      action: 'update'
    });
    return {
      ok: true,
      action: patched.action,
      path: path,
      changed: true,
      sha: written.sha,
      count: count
    };
  } catch (e) {
    if (!isShaConflict(e) || PUBLISH_CONFLICT_RETRIES < 1) {
      return { ok: false, error: path + ' : ' + redact(String(e && e.message ? e.message : e)) };
    }
    var fresh = getFile(path);
    if (!fresh) return { ok: false, error: path + ' : disparu après conflit de SHA.' };
    var again = upsertArticleInList(fresh.content, item);
    if (!again.ok) return { ok: false, error: path + ' : ' + again.error };
    // Le compte est RECALCULÉ sur le contenu relu : après un conflit, l'index a
    // pu changer entre-temps, et c'est cette version qui fait foi.
    var freshCount = (again.html.match(/<li class="article-item">/g) || []).length;
    if (again.html === fresh.content) {
      return { ok: true, action: 'unchanged', path: path, changed: false, sha: fresh.sha, count: freshCount };
    }
    var retried = createOrUpdate({
      path: path,
      content: again.html,
      message: message,
      sha: fresh.sha,
      action: 'update'
    });
    return { ok: true, action: again.action, path: path, changed: true, sha: retried.sha, count: freshCount };
  }
}

/* ------------------------------------------------------------------------ */
/* Compteurs de catégories du hub                                             */
/* ------------------------------------------------------------------------ */

/**
 * Recalcule les compteurs du `.cat-grid` du hub.
 *
 * Seules les valeurs passed dans `counts` sont réécrites : le nom, le lien, le
 * style et l'ordre des cartes sont intacts. Les compteurs des catégories non
 * listées sont LAISSÉS INTACTS, ce qui évite 4 lectures GitHub supplémentaires
 * par publication (les autres catégories n'ont pas changé).
 *
 * Le compte fourni doit provenir du nombre RÉEL de `<li class="article-item">`
 * de l'index de catégorie — c'est l'orchestrateur qui l'a compté sur le
 * contenu déjà patché, donc sans lecture additionnelle. Compter la liste du HUB
 * serait faux : elle ne liste qu'une sélection d'articles, pas une catégorie.
 *
 * Appelée à 1 argument, la fonction ne modifie RIEN et le signale : sans source
 * de vérité, mieux vaut un compteur en retard qu'un compteur faux.
 *
 * @param {string} hubHtml hub Blog existant
 * @param {Object} [counts] { slug: nombre } pour les catégories à recaler
 * @return {{ok:boolean, html?:string, changed?:boolean, error?:string}}
 */
function updateCategoryCounts(hubHtml, counts) {
  var source = String(hubHtml || '');
  var out = source;
  var changed = false;
  if (!counts || typeof counts !== 'object' || Object.keys(counts).length === 0) {
    return { ok: true, html: out, changed: false, error: 'Aucun compteur fourni : hub laissé intact.' };
  }
  var slugs = Object.keys(counts);

  for (var i = 0; i < slugs.length; i++) {
    var slug = slugs[i];
    var n = parseInt(counts[slug], 10);
    if (isNaN(n) || n < 0) continue;

    // Ancre sur le lien de la carte : jamais de confusion entre catégories.
    var anchor = BLOG_CARD_OPEN + '<a href="/blog/' + slug + '/">';
    var cardIdx = out.indexOf(anchor);
    if (cardIdx === -1) continue;

    var countIdx = out.indexOf('<div class="count">', cardIdx);
    if (countIdx === -1) continue;
    var countEnd = out.indexOf('</div>', countIdx);
    if (countEnd === -1) continue;

    var label = n + (n > 1 ? ' articles' : ' article');
    var replacement = '<div class="count">' + label;
    var current = out.slice(countIdx, countEnd);
    if (current === replacement) continue;

    out = out.slice(0, countIdx) + replacement + out.slice(countEnd);
    changed = true;
  }

  return { ok: true, html: out, changed: changed };
}

/* ------------------------------------------------------------------------ */
/* Sitemap                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Bloc `<url>…</url>` MULTI-LIGNE, au format EXACT de production.
 *
 * Fonction PUR. Le gabarit est celui de `public/sitemap.xml` : `<url>`
 * indenté de 2 espaces, enfants de 4, `</url>` refermé, un `xhtml:link` par
 * langue publiée puis `x-default` en DERNIER (ordre imposé par
 * buildHreflangLinks(), donc identique aux `<link rel="alternate">` de la
 * page). Une entrée sans alternate — le hub `/blog/` — n'a simplement aucune
 * ligne `xhtml:link`.
 *
 * @param {string} loc URL ABSOLUE
 * @param {string} lastmod date ISO YYYY-MM-DD
 * @param {Array<{lang:string,url:string}>} [alternates] vide ou absent = aucune ligne
 * @param {string} [changefreq] défaut `monthly` (hub : `weekly`)
 * @return {string}
 */
function buildSitemapUrlBlock(loc, lastmod, alternates, changefreq) {
  var lines = [
    '  <url>',
    '    <loc>' + escHtml(loc) + '</loc>',
    '    <lastmod>' + String(lastmod || '') + '</lastmod>',
    '    <changefreq>' + String(changefreq || 'monthly') + '</changefreq>',
    '    <priority>0.8</priority>'
  ];
  (Array.isArray(alternates) ? alternates : []).forEach(function (alt) {
    lines.push('    <xhtml:link rel="alternate" hreflang="' + escHtml(alt.lang) +
      '" href="' + escHtml(alt.url) + '"/>');
  });
  lines.push('  </url>');
  return lines.join('\n');
}

/**
 * Paires `{lang, url}` des alternates d'un article, DANS l'ordre du sitemap.
 *
 * SOURCE UNIQUE de vérité : `buildHreflangLinks()` du moteur de rendu. Les
 * `<xhtml:link>` du sitemap et les `<link rel="alternate">` de la page sont
 * donc produits par la même fonction, à partir des mêmes lignes PUBLIÉES du
 * groupe : la réciprocité n'est pas une coïncidence, elle est structurelle.
 * L'ordre est `APP.SUPPORTED_LANGS` puis `x-default`, ce qui est exactement
 * l'ordre des hreflangs du gabarit.
 *
 * @param {Object} article ligne `Articles` (LANG, SLUG, TRANSLATION_GROUP)
 * @param {Array<Object>} published lignes PUBLIÉES du groupe
 * @return {Array<{lang:string,url:string}>} vide si les alternates sont
 *         incalculables — l'entrée est alors écrite SANS hreflang, jamais avec
 *         des liens vides.
 */
function sitemapAlternatesFor(article, published) {
  var lang = String(article && article.LANG ? article.LANG : '').trim();
  var slug = String(article && article.SLUG ? article.SLUG : '').trim();
  if (!isSupportedLang(lang) || !isValidSlug(slug)) return [];

  var group = String(article.TRANSLATION_GROUP || '').trim() || slug;
  var links = buildHreflangLinks({
    lang: lang,
    slug: slug,
    group: group,
    sitePath: sitePath(lang, slug)
  }, published).links;

  var ordered = APP.SUPPORTED_LANGS.filter(function (code) {
    return Object.prototype.hasOwnProperty.call(links, code);
  }).map(function (code) {
    return { lang: code, url: links[code] };
  });
  if (links['x-default']) ordered.push({ lang: 'x-default', url: links['x-default'] });
  return ordered;
}

/**
 * Ajoute l'URL d'un article au sitemap, UNE SEULE FOIS.
 *
 * Fonction PUR. `</urlset>` est toujours préservé et les octets non concernés
 * sont renvoyés À L'IDENTIQUE : une entrée déjà présente n'est jamais
 * réécrite, donc une retouche manuelle du sitemap survit à la publication.
 *
 * @param {string} xml sitemap existant
 * @param {string} loc URL absolue, ex. https://menuscan.space/blog/fr/x.html
 * @param {string} lastmod date ISO YYYY-MM-DD
 * @param {Array<{lang:string,url:string}>} [alternates]
 * @param {string} [changefreq]
 * @return {{ok:boolean, html?:string, changed?:boolean, error?:string}}
 */
function insertIntoSitemap(xml, loc, lastmod, alternates, changefreq) {
  var source = String(xml || '');
  if (!loc) return { ok: false, error: 'URL d’article absente : sitemap non mis à jour.' };

  var date = String(lastmod || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'lastmod invalide : « ' + lastmod + ' » (attendu YYYY-MM-DD).' };
  }

  // Déjà présent → aucune écriture, même si l'entrée a été ajoutée à la main.
  if (source.indexOf('<loc>' + loc + '</loc>') !== -1) {
    return { ok: true, html: source, changed: false };
  }

  var closeIdx = source.lastIndexOf('</urlset>');
  if (closeIdx === -1) return { ok: false, error: 'Sitemap invalide : </urlset> introuvable.' };

  var entry = buildSitemapUrlBlock(loc, date, alternates, changefreq);

  // Le sitemap de production indente de 2 espaces chaque entrée et garde
  // `</urlset>` sur sa propre ligne. `slice(0, closeIdx)` se termine déjà par le
  // saut de ligne qui précède `</urlset>` : on le retire avant de joindre, sinon
  // la nouvelle entrée se retrouve précédée d'une ligne vide. Ce retrait rend
  // aussi le résultat correct si la source n'a pas ce saut de ligne.
  var head = source.slice(0, closeIdx).replace(/\n+$/, '');
  return {
    ok: true,
    changed: true,
    html: head + '\n' + entry + '\n' + source.slice(closeIdx)
  };
}

/**
 * Garantit la présence de l'entrée du HUB `/blog/` dans le sitemap.
 *
 * Fonction PUR, idempotente : si le hub est déjà décrit, le sitemap est
 * renvoyé STRICTEMENT identique (`changed:false`), même si l'entrée a été
 * écrite à la main. Le hub n'a pas d'alternate : il n'existe qu'en une seule
 * "langue", celle de la racine du blog.
 *
 * @param {string} xml sitemap existant
 * @param {string} lastmod date ISO YYYY-MM-DD de la dernière modif du hub
 * @return {{ok:boolean, html?:string, changed?:boolean, error?:string}}
 */
function ensureBlogHubInSitemap(xml, lastmod) {
  var source = String(xml || '');
  var loc = APP.SITE_ORIGIN + siteBlogRootPath();
  if (source.indexOf('<loc>' + loc + '</loc>') !== -1) {
    return { ok: true, html: source, changed: false };
  }
  return insertIntoSitemap(source, loc, lastmod, [], 'weekly');
}

/**
 * Date du jour au format `<lastmod>`, ou la date de l'article en repli.
 *
 * Le `<lastmod>` du hub `/blog/` est la date de MODIFICATION de cette page,
 * donc celle du jour où l'on réconcilie — pas celle de l'article traité. Il ne
 * sert qu'à la première insertion : l'entrée étant ensuite considérée présente,
 * elle n'est plus réécrite et la date ne dérive donc pas.
 *
 * @param {string} [fallbackDate]
 * @return {string} YYYY-MM-DD, ou '' si aucune date exploitable
 */
function indexGeneratedDate(fallbackDate) {
  var today = String(nowIso() || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(today)) return today;
  var fallback = String(fallbackDate || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : '';
}

/* ------------------------------------------------------------------------ */
/* articles.json : une entrée par article publié                              */
/* ------------------------------------------------------------------------ */
/**
 * Une entrée d'`articles.json`, au SCHÉMA EXACT déjà en production.
 *
 * Fonction PUR. L'ordre des clés est celui du fichier existant
 * (lang, slug, url, title, excerpt, category, date, readingTime, image,
 * imageAlt, imageWidth, imageHeight, translationGroup) : c'est cet ordre que
 * produit `JSON.stringify`, donc le fichier régénéré reste indiscernable du
 * fichier écrit à la main.
 *
 * RIEN n'est calculé : le temps de lecture est éditorial, l'URL est dérivée
 * de LANG+SLUG, l'excerpt reprend le même repli que la carte d'index et que
 * `og:description`, la catégorie est le SLUG (le libellé est traduit par le
 * moteur du hub, jamais stocké deux fois).
 *
 * @param {Object} article ligne `Articles`
 * @return {{ok:boolean, entry?:Object, error?:string}}
 */
function articleIndexRow(article) {
  var lang = String(article && article.LANG ? article.LANG : '').trim();
  if (!isSupportedLang(lang)) {
    return { ok: false, error: 'LANG inconnu pour articles.json : « ' + lang + ' ».' };
  }

  var slug = String(article && article.SLUG ? article.SLUG : '').trim();
  if (!isValidSlug(slug)) {
    return { ok: false, error: 'SLUG invalide pour articles.json : « ' + slug + ' ».' };
  }

  var categoryName = String(article.CATEGORY || '').trim();
  var categorySlug = getCategoryMap()[categoryName];
  if (!categorySlug) {
    return { ok: false, error: 'Catégorie inconnue pour articles.json : « ' + categoryName + ' ».' };
  }

  var reading = normalizeReadingTime(article.READING_TIME);
  if (reading.error) return { ok: false, error: reading.error };

  var date = String(article.PUBLISHED_AT || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      ok: false,
      error: 'PUBLISHED_AT illisible pour articles.json : « ' + article.PUBLISHED_AT +
        ' » (attendu YYYY-MM-DD).'
    };
  }

  var alt = String(article.IMAGE_ALT || '').trim();
  if (!alt) return { ok: false, error: 'IMAGE_ALT absent : articles.json l’expose aux lecteurs d’écran.' };

  var width = Number(article.IMAGE_WIDTH);
  var height = Number(article.IMAGE_HEIGHT);
  if (!(width > 0) || !(height > 0) || width % 1 !== 0 || height % 1 !== 0) {
    return {
      ok: false,
      error: 'IMAGE_WIDTH/IMAGE_HEIGHT invalides pour articles.json : « ' +
        article.IMAGE_WIDTH + '×' + article.IMAGE_HEIGHT + ' » (entiers positifs attendus).'
    };
  }

  return {
    ok: true,
    entry: {
      lang: lang,
      slug: slug,
      url: sitePath(lang, slug),
      title: String(article.TITLE || '').trim(),
      excerpt: indexCardExcerpt(article),
      category: String(categorySlug),
      date: date,
      readingTime: parseInt(reading.value, 10),
      image: indexImagePath(article),
      imageAlt: alt,
      imageWidth: width,
      imageHeight: height,
      translationGroup: String(article.TRANSLATION_GROUP || '').trim() || slug
    }
  };
}

/**
 * Chemin WEB de l'image d'un article, quelle que soit sa forme de saisie.
 *
 * Fonction PUR. `IMAGE_URL` peut être un chemin repo (`public/blog/…`), un
 * chemin web (`/blog/…`) ou une URL absolue du site : les trois désignent le
 * MÊME fichier et doivent produire la MÊME chaîne, sinon deux traductions
 * d'un même article exposeraient deux URL d'image différentes.
 *
 * @param {Object} article ligne `Articles`
 * @return {string} chemin web, ou '' si aucune image
 */
function indexImagePath(article) {
  var raw = String(article && article.IMAGE_URL ? article.IMAGE_URL : '').trim();
  if (!raw) return '';
  var path = raw.replace(/^https?:\/\/[^/]+/i, '').replace(/^public\//, '');
  if (path.charAt(0) !== '/') path = '/' + path;
  return path;
}

/**
 * Lignes PUBLIÉES servant de vérité aux index, l'article courant inclus et
 * dans l'état où il SERA publié.
 *
 * Le Publisher réconcilie les index AVANT de passer la ligne à PUBLISHED :
 * lue telle quelle, la ligne courante est encore READY et
 * `isPublishable()` la ferait disparaître de `articles.json`. On la remplace
 * donc ici par une copie portant le statut et la date RÉSOLUS — `article`
 * n'est jamais muté.
 *
 * @param {Object} article ligne courante
 * @param {{published?:Array<Object>, publishedAt?:string}} [options]
 * @return {{ok:boolean, rows:Array<Object>, source:string, error?:string}}
 */
function publishedIndexRows(article, options) {
  var opt = options || {};
  var rows = Array.isArray(opt.published) ? opt.published.slice() : null;
  var source = 'provided';

  if (!rows) {
    source = 'readArticles()';
    try {
      rows = readArticles();
    } catch (e) {
      return {
        ok: false, rows: [], source: source,
        error: redact(String(e && e.message ? e.message : e))
      };
    }
    if (!Array.isArray(rows)) {
      return { ok: false, rows: [], source: source, error: 'readArticles() a renvoyé autre chose qu’un tableau.' };
    }
  }

  var self = {};
  for (var k in article) {
    if (Object.prototype.hasOwnProperty.call(article, k)) self[k] = article[k];
  }
  self.STATUS = STATUS.PUBLISHED;
  if (opt.publishedAt) self.PUBLISHED_AT = String(opt.publishedAt).trim();

  var id = String(article && article.ID !== null && article.ID !== undefined ? article.ID : '').trim();
  var lang = String(article && article.LANG ? article.LANG : '').trim();
  var slug = String(article && article.SLUG ? article.SLUG : '').trim();

  var replaced = false;
  var out = [];
  rows.forEach(function (row) {
    var sameId = id && String(row.ID === null || row.ID === undefined ? '' : row.ID).trim() === id;
    var samePath = String(row.LANG || '').trim() === lang && String(row.SLUG || '').trim() === slug;
    if (sameId || samePath) {
      if (replaced) return;
      out.push(self);
      replaced = true;
      return;
    }
    out.push(row);
  });
  if (!replaced) out.push(self);

  return { ok: true, rows: out, source: source };
}

/**
 * Contenu COMPLET d'`articles.json`, PUBLISHED uniquement, trié.
 *
 * Fonction PUR, déterministe : même tableau de lignes + même `generatedAt`
 * produisent la MÊME chaîne, octet pour octet. `generatedAt` est le seul
 * champ non déterministe du fichier, et c'est sa raison d'être.
 *
 * Ordre : date décroissante, puis ID croissant. L'ID est le numéro de ligne
 * saisi dans la feuille, donc l'ordre éditorial saisi ; `lang` puis `slug` ne
 * servent qu'à rendre le tri TOTAL (deux lignes ne peuvent pas partager
 * LANG+SLUG, mais rien ne l'interdit dans la feuille).
 *
 * Une seule ligne inexploitable fait ÉCHOUER la construction : régénérer un
 * index amputé d'un article publié serait pire que de le laisser en retard.
 *
 * @param {Array<Object>} rows
 * @param {string} generatedAt horodatage ISO de génération
 * @return {{ok:boolean, json?:string, count?:number, error?:string}}
 */
function buildArticlesIndexJson(rows, generatedAt) {
  var stamp = String(generatedAt || '').trim();
  if (!stamp) return { ok: false, error: 'articles.json : horodatage de génération absent.' };

  var entries = [];
  var errors = [];
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!isPublishable(row)) return;
    var built = articleIndexRow(row);
    if (!built.ok) {
      errors.push((row && row.SLUG ? row.SLUG + ' : ' : '') + built.error);
      return;
    }
    entries.push({
      entry: built.entry,
      date: built.entry.date,
      id: String(row.ID === null || row.ID === undefined ? '' : row.ID).trim()
    });
  });

  if (errors.length) {
    return { ok: false, error: 'articles.json : ' + errors.length + ' ligne(s) inexploitable(s) — ' + errors.join(' | ') };
  }

  entries.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    var an = /^\d+$/.test(a.id) ? parseInt(a.id, 10) : null;
    var bn = /^\d+$/.test(b.id) ? parseInt(b.id, 10) : null;
    if (an !== null && bn !== null && an !== bn) return an - bn;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.entry.lang !== b.entry.lang) return a.entry.lang < b.entry.lang ? -1 : 1;
    if (a.entry.slug !== b.entry.slug) return a.entry.slug < b.entry.slug ? -1 : 1;
    return 0;
  });

  var payload = {
    version: 1,
    generatedAt: stamp,
    articles: entries.map(function (e) { return e.entry; })
  };
  return { ok: true, json: JSON.stringify(payload, null, 2) + '\n', count: payload.articles.length };
}

/**
 * Horodatage d'`articles.json`.
 *
 * `generatedAt` est le SEUL champ non déterministe du fichier. Le régénérer à
 * chaque exécution ferait échouer la comparaison octet pour octet de l'étape 4
 * et créerait un commit ne changeant qu'une date : la republication d'un article
 * déjà publié doit être totalement silencieuse.
 *
 * Le tampon existant est donc réutilisé si — et seulement si — la LISTE
 * d'articles est identique. Toute vraie modification (ajout, retrait, contenu,
 * ordre) prend un tampon neuf.
 *
 * Fonction PUR.
 *
 * @param {Array<Object>} rows lignes publiées
 * @param {string} now horodatage ISO proposé
 * @param {string} [existingText] contenu courant du fichier, si présent
 * @return {string} horodatage ISO à utiliser
 */
function articlesIndexStamp(rows, now, existingText) {
  var fallback = String(now || '').trim();
  if (!existingText) return fallback;

  var current = parseJsonSafe(existingText);
  if (!current || !Array.isArray(current.articles) || typeof current.generatedAt !== 'string') {
    return fallback;
  }

  // Le même constructeur produit les deux listes : l'ordre des clés est donc
  // identique, et une simple sérialisation suffit à conclure.
  var probe = buildArticlesIndexJson(rows, '1970-01-01T00:00:00.000Z');
  if (!probe.ok) return fallback;

  var rebuilt = parseJsonSafe(probe.json);
  if (!rebuilt || JSON.stringify(rebuilt.articles) !== JSON.stringify(current.articles)) {
    return fallback;
  }
  var kept = current.generatedAt.trim();
  return kept || fallback;
}

/* ------------------------------------------------------------------------ */
/* Orchestration                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Écriture d'un index PARTAGÉ, avec retry borné sur conflit de SHA.
 *
 * `articles.json` et `sitemap.xml` sont écrits par TOUS les articles : c'est
 * donc sur ces deux fichiers que se disputent les publications. Un 409 signifie
 * « le dépôt a bougé entre ma lecture et mon écriture » — un état déjà résolu
 * côté dépôt, qu'un retry borné suffit à rattraper, et non une panne. Sans ce
 * retry, l'opérateur devrait republier sa ligne à la main pour un conflit qui ne
 * le concerne pas.
 *
 * `stager(content)` est RÉÉVALUÉ après la relecture : le contenu distant a pu
 * changer entre-temps, et rejouer un patch calculé sur la version précédente
 * ÉCRASERAIT la publication concurrente.
 *
 * @param {string} path chemin REPO de l'index
 * @param {function(string):{ok:boolean, html?:string, changed?:boolean, error?:string}} stager
 *        prépare le contenu à partir de l'état DISTANT courant
 * @param {string} message message de commit
 * @return {{ok:boolean, path:string, changed:boolean, sha:string, existed:boolean,
 *           retried:boolean, staged:Object}}
 */
function writeSharedIndex(path, stager, message) {
  var existing = getFile(path);
  var existed = !!existing;
  var staged = stager(existing ? existing.content : '');
  if (!staged || staged.ok !== true) {
    return {
      ok: false, path: path, changed: false, sha: '', existed: existed, retried: false, staged: staged || {},
      error: path + ' : ' + ((staged && staged.error) || 'préparation impossible')
    };
  }
  if (!staged.changed) {
    return {
      ok: true, path: path, changed: false, sha: existed ? existing.sha : '', existed: existed,
      retried: false, staged: staged
    };
  }

  try {
    var written = createOrUpdate({
      path: path, content: staged.html, message: message,
      sha: existed ? existing.sha : '', action: existed ? 'update' : 'create'
    });
    return { ok: true, path: path, changed: true, sha: written.sha, existed: existed, retried: false, staged: staged };
  } catch (e) {
    if (!isShaConflict(e) || PUBLISH_CONFLICT_RETRIES < 1) throw e;
  }

  var fresh = getFile(path);
  var again = stager(fresh ? fresh.content : '');
  if (!again || again.ok !== true) {
    return {
      ok: false, path: path, changed: false, sha: '', existed: !!fresh, retried: true, staged: again || {},
      error: path + ' : ' + ((again && again.error) || 'recalcul impossible après conflit de SHA')
    };
  }
  if (!again.changed) {
    // L'autre publication avait déjà écrit exactement ce qu'on allait écrire.
    return { ok: true, path: path, changed: false, sha: fresh ? fresh.sha : '', existed: !!fresh, retried: true, staged: again };
  }
  var retried = createOrUpdate({
    path: path, content: again.html, message: message,
    sha: fresh ? fresh.sha : '', action: fresh ? 'update' : 'create'
  });
  return { ok: true, path: path, changed: true, sha: retried.sha, existed: !!fresh, retried: true, staged: again };
}
/* ------------------------------------------------------------------------ */

/**
 * Réconcilie les index statiques d'un article fraîchement publié.
 *
 * SÉQUENCE IMPOSÉE : articles.json → sitemap. Ce Blog n'a AUCUN index de
 * catégorie et son hub est dynamique : ni l'un ni l'autre ne porte d'écriture.
 *
 * Appelé UNIQUEMENT après le succès de writeArticleFile(). Un échec d'index ne
 * remonte JAMAIS en exception et ne modifie JAMAIS le statut PUBLISHED :
 * l'article EST publié, seul son référencement statique peut être en retard.
 * Chaque étape est isolée : l'échec du sitemap n'annule pas articles.json, et
 * inversement.
 *
 * `ok:false` n'est donc PAS une alerte parmi d'autres : c'est un état que
 * Publisher.gs traduit en colonne ERROR + journal ERROR
 * (`markIndexFailure()`), jamais en simple `warning`. Ici on se contente de
 * décrire la cause ; qui décide de l'affichage, c'est l'appelant.
 *
 * @param {Object} article ligne `Articles` (après écriture)
 * @param {{sitePath?:string, publishedAt?:string}} [options]
 *        `publishedAt` est la date RÉSOLUE par le Publisher : un article
 *        nouvellement publié n'a pas encore de PUBLISHED_AT en colonne, or la
 *        date alimente à la fois le libellé de la carte et le <lastmod>.
 * @return {{ok:boolean, indexed:boolean, categoryIndex:Object, hub:Object,
 *           sitemap:Object, warnings:Array<Object>, writes:number}}
 */
function updateIndexesForArticle(article, options) {
  var opt = options || {};
  var warnings = [];
  var report = {
    ok: true,
    indexed: true,
    writes: 0,
    categoryIndex: { path: '', action: 'skipped' },
    hub: { path: BLOG_HUB_PATH, action: 'skipped' },
    sitemap: { path: APP.SITEMAP_PATH, action: 'skipped' },
    articlesIndex: { path: APP.ARTICLES_INDEX_PATH, action: 'skipped' },
    warnings: warnings
  };

  // Copie enrichie : la date résolue prime sur la colonne, qui peut être vide
  // pour une première publication. `article` n'est jamais muté.
  var resolved = {};
  for (var k in article) {
    if (Object.prototype.hasOwnProperty.call(article, k)) resolved[k] = article[k];
  }
  if (opt.publishedAt && !String(resolved.PUBLISHED_AT || '').trim()) {
    resolved.PUBLISHED_AT = String(opt.publishedAt).trim();
  }

  // Vérité des lignes PUBLIÉES, lue UNE fois pour le sitemap (alternates) et
  // pour articles.json. Elle est consultée APRÈS l'écriture de l'article mais
  // AVANT le passage à PUBLISHED : c'est pourquoi la ligne courante y est
  // réinjectée dans son état résolu. Un échec de lecture n'interrompt rien :
  // les alternates sont alors omis et articles.json est déclaré en retard.
  var rows = publishedIndexRows(resolved, opt);
  if (!rows.ok) {
    warnings.push({
      code: 'IX0b',
      message: 'Lignes publiées illisibles (' + rows.source + ') : sitemap sans alternate, ' +
        'articles.json non réécrit — ' + rows.error
    });
  }

  var item = buildArticleListItem(resolved, { withCategory: false, sitePath: opt.sitePath });
  if (!item.ok) {
    report.ok = false;
    report.indexed = false;
    warnings.push({ code: 'IX0', message: 'Index non réconcilié : ' + item.error });
    return report;
  }
  var categorySlug = item.categorySlug;
  var categoryPath = APP.BLOG_DIR + '/' + categorySlug + '/index.html';
  report.categoryIndex.path = categoryPath;

  /* --- 1. Index de catégorie -------------------------------------------- */
  var category = upsertArticleInIndexFile(categoryPath, item, {
    message: 'Index : ' + (resolved.SLUG || '') + ' (' + categorySlug + ')',
    allowAbsent: true
  });
  if (!category.ok) {
    report.ok = false;
    report.indexed = false;
    report.categoryIndex.action = 'error';
    warnings.push({ code: 'IX1', message: 'Index de catégorie : ' + category.error });
  } else {
    report.categoryIndex = category;
    if (category.changed) report.writes += 1;
  }

  /* --- 2. Hub Blog ------------------------------------------------------ */
  try {
    var hubExisting = getFile(BLOG_HUB_PATH);
    if (!hubExisting) throw new Error('Hub absent du dépôt : ' + BLOG_HUB_PATH);

    if (hubExisting.content.indexOf(BLOG_LIST_OPEN) === -1) {
      // Hub RENDU À L'EXÉCUTION : public/blog/index.html n'a pas de liste
      // statique, `blog.js` construit `#b-list` à partir d'articles.json. Il n'y
      // a donc rien à réconcilier dans le HTML, et surtout aucune carte à y
      // écrire : elle serait écrasée au prochain rendu. La mise à jour du hub
      // EST l'étape 4 (articles.json). Ni erreur, ni écriture.
      report.hub = { path: BLOG_HUB_PATH, action: 'dynamic', changed: false, sha: hubExisting.sha };
    } else {
      var hubItem = buildArticleListItem(resolved, { withCategory: true, sitePath: opt.sitePath });
      if (!hubItem.ok) throw new Error(hubItem.error);

      var hubList = upsertArticleInList(hubExisting.content, hubItem);
      if (!hubList.ok) throw new Error(hubList.error);

      // Compteur = nombre RÉEL d'entrées de l'INDEX DE CATÉGORIE patché à
      // l'étape 1, pas du hub : le hub ne liste qu'une sélection d'articles,
      // donc compter sa propre liste donnerait un total sans rapport avec la
      // catégorie. Les 4 autres compteurs restent intacts (elles n'ont pas bougé).
      var countedMap = {};
      if (category.ok && typeof category.count === 'number' && !category.absent) {
        countedMap[categorySlug] = category.count;
      }
      var hubHtml = updateCategoryCounts(hubList.html, countedMap).html;

      if (hubHtml === hubExisting.content) {
        report.hub = { path: BLOG_HUB_PATH, action: 'unchanged', changed: false, sha: hubExisting.sha };
      } else {
        var hubWritten = createOrUpdate({
          path: BLOG_HUB_PATH,
          content: hubHtml,
          message: 'Hub : ' + (resolved.SLUG || ''),
          sha: hubExisting.sha,
          action: 'update'
        });
        report.hub = { path: BLOG_HUB_PATH, action: hubList.action, changed: true, sha: hubWritten.sha };
        report.writes += 1;
      }
    }
  } catch (e) {
    report.ok = false;
    report.indexed = false;
    report.hub.action = 'error';
    warnings.push({ code: 'IX2', message: 'Hub Blog : ' + redact(String(e && e.message ? e.message : e)) });
  }

  /* --- 3. articles.json ------------------------------------------------- */
  try {
    if (!rows.ok) throw new Error('lignes publiées illisibles (' + rows.source + ') : ' + rows.error);

    // Reconstruction COMPLÈTE à partir des lignes publiées : c'est ce qui
    // empêche un index de dériver (entrée orpheline, doublon, ordre faux).
    // `stager` est réévalué après un conflit de SHA, sur le contenu relu.
    var jsonWrite = writeSharedIndex(APP.ARTICLES_INDEX_PATH, function (current) {
      // Le tampon n'est renouvelé que si la liste change vraiment : sinon la
      // republication d'un article déjà publié est strictement silencieuse.
      var stamp = articlesIndexStamp(rows.rows, nowIso(), current);
      var built = buildArticlesIndexJson(rows.rows, stamp);
      if (!built.ok) return { ok: false, error: built.error };
      return { ok: true, html: built.json, changed: current !== built.json, count: built.count };
    }, 'articles.json : ' + (resolved.SLUG || ''));
    if (!jsonWrite.ok) throw new Error(jsonWrite.error);

    report.articlesIndex = {
      path: APP.ARTICLES_INDEX_PATH,
      action: jsonWrite.changed ? (jsonWrite.existed ? 'updated' : 'created') : 'unchanged',
      changed: jsonWrite.changed,
      sha: jsonWrite.sha,
      retried: jsonWrite.retried,
      count: jsonWrite.staged.count
    };
    if (jsonWrite.changed) report.writes += 1;
  } catch (e) {
    report.ok = false;
    report.indexed = false;
    report.articlesIndex.action = 'error';
    warnings.push({ code: 'IX4', message: 'articles.json : ' + redact(String(e && e.message ? e.message : e)) });
  }

  /* --- 4. Sitemap ------------------------------------------------------- */
  try {
    // URL de l'entrée : le chemin RÉSOLU par le rendu quand il existe (c'est
    // le fichier qui vient d'être écrit), sinon le chemin canonique
    // LANG+SLUG. Les alternates, eux, sont toujours dérivés de LANG+SLUG :
    // ils décrivent les AUTRES pages du groupe, pas le rendu courant.
    var selfHref = opt.sitePath ? item.href : sitePath(String(resolved.LANG || ''), String(resolved.SLUG || ''));
    var loc = APP.SITE_ORIGIN + selfHref;
    var alternates = rows.ok ? sitemapAlternatesFor(resolved, rows.rows) : [];

    // Le hub `/blog/` est une page à part entière du sitemap : on le garantit
    // à chaque publication, y compris quand l'entrée de l'article existait
    // déjà (donc aucune écriture de sitemap par ailleurs). Idempotent.
    var hubDate = indexGeneratedDate(resolved.PUBLISHED_AT);

    // Tout le patch est REFAIT sur l'état distant courant : insertion, réciprocité
    // des alternates du groupe, puis garantie du hub. Un conflit de SHA rejoue
    // cette même préparation sur le document relu.
    var sitemapWrite = writeSharedIndex(APP.SITEMAP_PATH, function (current) {
      // Jamais de CRÉATION : un sitemap manquant est une panne de configuration
      // du dépôt, pas un index à réconcilier.
      if (!current) return { ok: false, error: 'Sitemap absent du dépôt : ' + APP.SITEMAP_PATH };
      var patched = insertIntoSitemap(current, loc, resolved.PUBLISHED_AT, alternates);
      if (!patched.ok) return { ok: false, error: patched.error };

      // RÉCIPROCITÉ : ajouter l'entrée d'une nouvelle traduction ne suffit pas,
      // les entrées des traductions déjà publiées doivent la CITER aussi.
      var reciprocal = rows.ok
        ? reconcileSitemapAlternates(patched.html, sitemapGroupLocs(resolved, rows.rows), alternates)
        : { ok: true, html: patched.html, changed: false, touched: 0 };
      if (!reciprocal.ok) return { ok: false, error: reciprocal.error };

      var staged = hubDate
        ? ensureBlogHubInSitemap(reciprocal.html, hubDate)
        : { ok: true, html: reciprocal.html, changed: patched.changed || reciprocal.changed };
      if (!staged.ok) return { ok: false, error: staged.error };

      return {
        ok: true, html: staged.html, changed: staged.html !== current,
        inserted: patched.changed, reciprocal: reciprocal.touched
      };
    }, 'Sitemap : ' + (resolved.SLUG || ''));
    if (!sitemapWrite.ok) throw new Error(sitemapWrite.error);

    var stagedInfo = sitemapWrite.staged;
    report.sitemap = {
      path: APP.SITEMAP_PATH,
      action: sitemapWrite.changed
        ? (stagedInfo.inserted ? 'inserted' : (stagedInfo.reciprocal ? 'reciprocal' : 'hub'))
        : 'unchanged',
      changed: sitemapWrite.changed,
      reciprocal: stagedInfo.reciprocal || 0,
      retried: sitemapWrite.retried,
      sha: sitemapWrite.sha
    };
    if (sitemapWrite.changed) report.writes += 1;
  } catch (e) {
    report.ok = false;
    report.indexed = false;
    report.sitemap.action = 'error';
    warnings.push({ code: 'IX3', message: 'Sitemap : ' + redact(String(e && e.message ? e.message : e)) });
  }

  if (!report.ok) {
    logWarning('publish', 'Article publié mais index Blog non réconcilié.', {
      articleId: article.ID,
      slug: article.SLUG,
      githubPath: article.GITHUB_PATH,
      details: { warnings: warnings.length, writes: report.writes }
    });
  }

  return report;
}

/* ========================================================================== */
/* D5 — SUPPRESSION D'UN ARTICLE : inverses stricts des fonctions ci-dessus    */
/* ========================================================================== */
/*
 * Principes (mêmes invariants que la partie « ajout ») :
 *   - PUR d'abord : removeFromArticleList(), removeFromHub() et
 *     removeFromSitemap() ne lisent ni n'écrivent GitHub. Elles sont donc
 *     testables octet par octet, sans mocks ni réseau ;
 *   - JAMAIS de régénération : on ne reconstruit pas une page, on retire
 *     l'entrée exacte. Les octets non concernés sont renvoyés À L'IDENTIQUE ;
 *   - L'identité est le HREF (index) et la LOC (sitemap). Jamais le titre,
 *     jamais les métadonnées, jamais le texte de catégorie : le hub porte un
 *     `<div class="meta">` qui contient la catégorie, les index de catégorie
 *     ne le portent pas — le href est donc le SEUL identifiant commun ;
*   - IDEMPOTENT : une entrée déjà absente renvoie `changed:false` sans écriture ;
 *   - SÉQUENCE IMPOSÉE : articles.json → sitemap, et le FICHIER ARTICLE EST
 *     SUPPRIMÉ EN DERNIER (Publisher.gs). L'index de catégorie n'existe pas dans
 *     ce Blog et le hub est dynamique : ni l'un ni l'autre ne porte d'écriture.
 */

/** Longueur de la balise fermante `</url>` (bornes du retrait sitemap). */
var SITEMAP_URL_CLOSE_LEN = 6;

/** Nombre réel d'entrées d'une liste d'articles. */
function countArticleItems(html) {
  return (String(html || '').match(/<li class="article-item">/g) || []).length;
}

/* ------------------------------------------------------------------------ */
/* Retrait d'une carte de liste                                              */
/* ------------------------------------------------------------------------ */

/**
 * Retire LA carte correspondant au href exact, et elle seule.
 *
 * Fonction PUR : ne lit ni n'écrit GitHub. Miroir exact de
 * upsertArticleInList() — même découpage (ARTICLE_ITEM_RE), même ancre
 * (`<ul class="article-list">`) — donc un aller-retour ajout/suppression est
 * sans dérive.
 *
 * L'IDENTITÉ EST LE HREF. Aucun titre, aucune métadonnée, aucun texte de
 * catégorie n'est utilisé pour reconnaître l'entrée : c'est la seule clé
 * commune à l'index de catégorie et au hub.
 *
 * Le retrait emporte le saut de ligne ET l'indentation de la ligne retirée
 * afin de ne laisser ni ligne vide ni indentation orpheline. S'il s'agit de la
 * dernière carte, c'est le séparateur PRÉCÉDENT qui est emporté.
 *
 * @param {string} html page d'index existante
 * @param {string} href href EXACT de l'article, ex. /blog/tva/taux.html
 * @return {{ok:boolean, html:string, changed:boolean, removed:boolean,
 *           count:number, error?:string}}
 */
function removeFromArticleList(html, href) {
  var source = String(html || '');
  var target = String(href || '');
  if (!target) {
    return { ok: false, html: source, changed: false, removed: false, count: countArticleItems(source), error: 'href absent : aucune carte ciblée.' };
  }

  var openIdx = source.indexOf(BLOG_LIST_OPEN);
  if (openIdx === -1) {
    return { ok: false, html: source, changed: false, removed: false, count: 0, error: 'Liste d’articles absente : ' + BLOG_LIST_OPEN + ' introuvable.' };
  }
  var bodyStart = openIdx + BLOG_LIST_OPEN.length;
  var closeIdx = source.indexOf('</ul>', bodyStart);
  if (closeIdx === -1) {
    return { ok: false, html: source, changed: false, removed: false, count: 0, error: 'Liste d’articles non fermée : </ul> introuvable.' };
  }

  var body = source.slice(bodyStart, closeIdx);
  var needle = 'href="' + target + '"';

  ARTICLE_ITEM_RE.lastIndex = 0;
  var hits = [];
  var m;
  while ((m = ARTICLE_ITEM_RE.exec(body)) !== null) {
    if (m[0].indexOf(needle) !== -1) hits.push(m);
  }

  // Absent : aucune écriture. C'est ce qui rend le retrait idempotent.
  if (!hits.length) {
    return { ok: true, html: source, changed: false, removed: false, count: countArticleItems(body) };
  }
  // Anomalie de contenu : deux cartes pour un seul href. On REFUSE plutôt que
  // de choisir arbitrairement — une suppression destructive ne devine pas.
  if (hits.length > 1) {
    return {
      ok: false, html: source, changed: false, removed: false,
      count: countArticleItems(body),
      error: 'Anomalie : ' + hits.length + ' cartes portent le href « ' + target + ' ». Suppression refusée.'
    };
  }

  var hit = hits[0];
  var end = hit.index + hit[0].length;
  var start = hit.index;
  var nlAfter = /^(\r\n|\n|\r)/.exec(body.slice(end));
  var follows = nlAfter !== null && body.slice(end + nlAfter[0].length).indexOf(BLOG_ITEM_OPEN) === 0;

  if (follows) {
    // Une carte suit : on emporte le saut de ligne + l'indentation qui
    // précèdent la carte suivante, sinon il resterait une indentation nue.
    var indent = /^[ \t]*/.exec(body.slice(end + nlAfter[0].length))[0];
    end += nlAfter[0].length + indent.length;
  } else {
    // Dernière carte (ou unique) : on emporte le saut de ligne + l'indentation
    // qui la précèdent, sinon il resterait une ligne vide avant `</ul>`.
    var before = /(\r\n|\n|\r)[ \t]*$/.exec(body.slice(0, hit.index));
    if (before) start = hit.index - before[0].length;
  }

  var newBody = body.slice(0, start) + body.slice(end);
  var out = source.slice(0, bodyStart) + newBody + source.slice(closeIdx);
  return {
    ok: true,
    html: out,
    changed: true,
    removed: true,
    count: countArticleItems(newBody)
  };
}

/**
 * Retire la carte de l'index de catégorie.
 *
 * Le `<h2>` n'est JAMAIS retiré, même quand la liste devient vide. Un titre de
 * section porte du texte réel : l'effacer serait une perte éditoriale, et le
 * risque de le faire à tort (mauvaise catégorie, comparaison d'accent, entité
 * HTML, `<h2>` de navigation) dépasse largement le bénéfice esthétique. Un
 * `<h2>` « Articles publiés » au-dessus d'une liste vide est un défaut
 * cosmétique, réversible à la main, sans lien cassé et sans effet sur le SEO
 * comme sur le compteur du hub — qui est, lui, recalculé.
 *
 * Le retrait est donc strictement le même que dans `removeFromArticleList()`,
 * mais avec son propre nom : l'appelant se documente ainsi, et la garantie
 * « aucun titre touché » est explicite dans le code.
 *
 * @param {string} html
 * @param {string} href
 * @return {{ok:boolean, html:string, changed:boolean, removed:boolean, count:number}}
 */
function removeFromCategoryList(html, href) {
  return removeFromArticleList(html, href);
}

/**
 * Retrait dans le hub : la carte d'article PLUS le compteur de sa catégorie.
 *
 * Aucune suppression de la carte `cat-card` : même à 0 article, la catégorie
 * reste un point d'entrée navigable. Faire disparaître une catégorie est une
 * décision éditoriale, jamais un effet de bord technique.
 *
 * Le compteur est fourni par l'orchestrateur (nombre RÉEL d'entrées de l'index
 * de catégorie, relu à l'étape précédente) — exactement la règle déjà appliquée
 * par updateIndexesForArticle(), qui ne recompte jamais la liste du hub.
 *
 * @param {string} html hub existant
 * @param {string} href href EXACT de l'article
 * @param {string} categorySlug slug de la catégorie
 * @param {number} [count] total de la catégorie ; absent = compteur inchangé
 */
function removeFromHub(html, href, categorySlug, count) {
  var source = String(html || '');
  var slug = String(categorySlug || '').trim();
  var link = String(href || '');

  // Garde STRUCTUREL (pas de métadonnée, pas de texte) : le href porte lui-même
  // le segment de catégorie, ce que l'on vérifie sur la chaîne du href.
  if (slug) {
    if (link.indexOf('/' + APP.BLOG_DIR + '/' + slug + '/') === -1) {
      return { ok: false, html: source, changed: false, removed: false, error: 'Le href « ' + href + ' » n’appartient pas à la catégorie « ' + slug + ' ».' };
    }
  }

  var card = removeFromArticleList(source, href);
  if (!card.ok) return { ok: false, html: source, changed: false, removed: false, error: card.error };
  if (!card.removed) return { ok: card.ok, html: source, changed: false, removed: false, count: card.count };

  var out = card.html;
  var counted = false;
  if (typeof count === 'number' && !isNaN(count)) {
    var applied = updateCategoryCounts(out, (function () {
      var map = {};
      map[slug] = count;
      return map;
    })());
    out = applied.html;
    counted = applied.changed === true;
  }

  return {
    ok: true,
    html: out,
    changed: out !== source,
    removed: true,
    count: card.count,
    countUpdated: counted
  };
}

/* ------------------------------------------------------------------------ */
/* Retrait du sitemap                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Retire l'entrée `<url>…</url>` qui porte EXACTEMENT cette URL.
 *
 * Fonction PUR. JAMAIS de suppression par ligne : le sitemap de production
 * contient des entrées `single-line` ET des entrées `multi-line` (avec
 * `xhtml:link`), et sa dernière entrée est collée à `</urlset>`. Une approche
 * par ligne échouerait sur les deux formats. On travaille donc sur le BLOC.
 *
 * L'ancre est `lastIndexOf('<url>', iLoc)` et non `indexOf` : une entrée
 * voisine peut contenir la chaîne `<url>` ailleurs, et une recherche depuis le
 * début viserait le mauvais bloc — c'est-à-dire la suppression d'une AUTRE
 * page. C'est le risque central de cette fonction.
 *
 * @param {string} xml sitemap existant
 * @param {string} loc URL ABSOLUE exacte, ex. https://menuscan.space/blog/fr/x.html
 * @return {{ok:boolean, html:string, changed:boolean, removed:boolean, error?:string}}
 */
function removeFromSitemap(xml, loc) {
  var source = String(xml || '');
  var target = String(loc || '');
  if (!target) {
    return { ok: false, html: source, changed: false, removed: false, error: 'URL absente : sitemap non modifié.' };
  }

  var locTag = '<loc>' + target + '</loc>';
  var iLoc = source.indexOf(locTag);
  // Déjà absent → aucune écriture, même si l'entrée a été retirée à la main.
  if (iLoc === -1) return { ok: true, html: source, changed: false, removed: false };

  var iOpen = source.lastIndexOf('<url>', iLoc);
  var iClose = source.indexOf('</url>', iLoc);
  if (iOpen === -1 || iClose === -1) {
    return {
      ok: false, html: source, changed: false, removed: false,
      error: 'Sitemap invalide : bloc <url>…</url> introuvable autour de ' + target + '.'
    };
  }

  var blockEnd = iClose + SITEMAP_URL_CLOSE_LEN;

  // UN SEUL séparateur est retiré : celui qui SUIT le bloc, s'il existe.
  //
  // Retirer AUSSI le saut de ligne précédant consommait deux séparateurs pour
  // un seul bloc : les deux entrées voisines se retrouvaient soudées sur une
  // même ligne (`</url>  <url>`), ce qui reste du XML valide mais jure avec le
  // format de production et pollue le diff du sitemap. Une seule règle couvre
  // les deux formes :
  //
  //   - saut de ligne après `</url>`  → on retire [bloc + ce saut de ligne],
  //     le saut de ligne PRÉCÉDENT reste et porte l'indentation du voisin ;
  //   - aucune fin de ligne après    → on retire [bloc] seul, et le saut de
  //     ligne qui précède devient le séparateur de `</urlset>`.
  //
  // `lastIndexOf('<url>')` s'arrête sur la balise, PAS sur son indentation : on
  // recule donc jusqu'au début de la ligne quand il n'y a rien d'autre que du
  // blanc devant le bloc. Sans cela, les 2 espaces de l'entrée retirée
  // resteraient collés à l'entrée suivante (`    <url>` au lieu de `  <url>`).
  var lineStart = source.lastIndexOf('\n', iOpen - 1) + 1;
  var start = /^[ \t]*$/.test(source.slice(lineStart, iOpen)) ? lineStart : iOpen;
  var nlAfter = /^(\r\n|\n|\r)/.exec(source.slice(blockEnd));
  var end = nlAfter ? blockEnd + nlAfter[0].length : blockEnd;

  return {
    ok: true,
    changed: true,
    removed: true,
    html: source.slice(0, start) + source.slice(end)
  };
}

/* ------------------------------------------------------------------------ */
/* Alternates orphelins : une traduction supprimée doit disparaître des       */
/* entrées de ses traductions restantes                                      */
/* ------------------------------------------------------------------------ */

/**
 * Retrait, dans un bloc `<url>…</url>`, des `xhtml:link` dont le `href` est
 * listé dans `dead`, puis réparation du `x-default`.
 *
 * Fonction PUR, locale au bloc. Deux formes sont traitées :
 *   - FORME BLOC (production) : chaque `xhtml:link` occupe sa propre ligne.
 *     Le retrait emporte l'INDENTATION et le SAUT DE LIGNE de cette ligne,
 *     sinon il laisserait une ligne vide dans l'entrée.
 *   - FORME INLINE (entrées historiques sur une ligne) : le retrait emporte
 *     l'espace qui précède la balise.
 * Un bloc sans aucun `href` mort est renvoyé STRICTEMENT identique.
 */
function stripAlternateLinksFromBlock(block, dead, defaultTarget) {
  var re = /<xhtml:link\b[^>]*\/>/g;
  var cuts = [];
  var m;
  while ((m = re.exec(block)) !== null) {
    var href = /href="([^"]*)"/.exec(m[0]);
    if (!href || !dead[href[1]]) continue;

    var start = m.index;
    var end = m.index + m[0].length;

    var lineStart = block.lastIndexOf('\n', start - 1) + 1;
    var nlAfter = block.indexOf('\n', end);
    var tail = block.slice(end, nlAfter === -1 ? block.length : nlAfter);
    if (/^[ \t]*$/.test(block.slice(lineStart, start)) && /^[ \t]*$/.test(tail)) {
      start = lineStart;
      if (nlAfter !== -1) end = nlAfter + 1;
    } else {
      // Forme inline : on mange l'espace séparateur qui précède la balise.
      var ws = /[ \t]+$/.exec(block.slice(0, start));
      if (ws) start -= ws[0].length;
    }
    cuts.push({ start: start, end: end });
  }
  if (!cuts.length) return { block: block, changed: false };

  var out = '';
  var cursor = 0;
  cuts.forEach(function (cut) {
    out += block.slice(cursor, cut.start);
    cursor = cut.end;
  });
  out += block.slice(cursor);

  // `x-default` : s'il pointait sur une URL retirée, il doit reprendre une
  // cible VIVANTE — le français du groupe s'il survit, sinon l'URL de
  // l'entrée elle-même. C'est la même règle que buildHreflangLinks().
  var dm = /<xhtml:link\b[^>]*hreflang="x-default"[^>]*\/>/.exec(out);
  if (dm) {
    var current = /href="([^"]*)"/.exec(dm[0]);
    if (current && dead[current[1]] && defaultTarget) {
      out = out.replace(dm[0], '<xhtml:link rel="alternate" hreflang="x-default" href="' +
        escHtml(defaultTarget) + '"/>');
    }
  } else if (defaultTarget) {
    var line = '<xhtml:link rel="alternate" hreflang="x-default" href="' + escHtml(defaultTarget) + '"/>';
    // L'entrée garde sa forme : ligne dedentée dans un bloc, ligne collée à
    // `</url>` dans une entrée inline.
    if (out.indexOf('\n') !== -1) {
      out = out.replace(/([ \t]*)<\/url>$/, function (_, indent) { return '    ' + line + '\n' + indent + '</url>'; });
    } else {
      out = out.replace(/<\/url>$/, line + '</url>');
    }
  }

  return { block: out, changed: true };
}

/**
 * Nettoie les `xhtml:link` orphelins de TOUTES les entrées du sitemap.
 *
 * Fonction PUR. Appelé après `removeFromSitemap()` : retirer l'entrée d'une
 * traduction ne suffit pas, les entrées des TRADUCTIONS RESTANTES porteraient
 * un `href` mort — un hreflang vers une page 404. Chaque entrée qui cite une
 * URL retirée est donc réparée, les autres sont renvoyées à l'octet près.
 *
 * @param {string} xml sitemap
 * @param {string[]} deadUrls URLs ABSOLUES retirées
 * @param {Object<string,string>} [remainingLangs] `{lang: url}` du groupe restant
 * @return {{ok:boolean, html:string, changed:boolean, touched:number}}
 */
function stripAlternatesFromSitemap(xml, deadUrls, remainingLangs) {
  var source = String(xml || '');
  var dead = {};
  (Array.isArray(deadUrls) ? deadUrls : []).forEach(function (u) {
    if (u) dead[String(u)] = true;
  });
  if (!Object.keys(dead).length) return { ok: true, html: source, changed: false, touched: 0 };

  var remaining = remainingLangs || {};
  var touched = 0;
  var patched = source.replace(/<url>[\s\S]*?<\/url>/g, function (block) {
    var loc = /<loc>([^<]*)<\/loc>/.exec(block);
    var target = remaining[APP.DEFAULT_LANG] || (loc ? loc[1] : '');
    var result = stripAlternateLinksFromBlock(block, dead, target);
    if (result.changed) touched += 1;
    return result.block;
  });

  return { ok: true, html: touched ? patched : source, changed: touched > 0, touched: touched };
}

/**
 * URLs ABSOLUES des entrées sitemap de TOUS les traductions publiées d'un groupe.
 *
 * Fonction PUR. Sert à la réconciliation de réciprocité : la liste des `<url>`
 * à réécrire, pas seulement celle de l'article en cours de publication.
 * L'entrée courante est incluse (son bloc vient d'être inséré avec les mêmes
 * alternats, donc elle ressort inchangée), ce qui garde l'opération totale.
 *
 * @param {Object} article ligne courante
 * @param {Array<Object>} published lignes PUBLIÉES du groupe
 * @return {string[]}
 */
function sitemapGroupLocs(article, published) {
  var lang = String(article && article.LANG ? article.LANG : '').trim();
  var slug = String(article && article.SLUG ? article.SLUG : '').trim();
  if (!isSupportedLang(lang) || !isValidSlug(slug)) return [];

  var group = String(article.TRANSLATION_GROUP || '').trim() || slug;
  var locs = [APP.SITE_ORIGIN + sitePath(lang, slug)];
  (Array.isArray(published) ? published : []).forEach(function (row) {
    var l = String(row.LANG || '').trim();
    var s = String(row.SLUG || '').trim();
    if (!isSupportedLang(l) || !isValidSlug(s)) return;
    if (String(row.TRANSLATION_GROUP || '').trim() !== group) return;
    var href = APP.SITE_ORIGIN + sitePath(l, s);
    if (locs.indexOf(href) === -1) locs.push(href);
  });
  return locs;
}

/**
 * Remplace TOUS les `xhtml:link` d'un bloc `<url>` par `lines`.
 *
 * Fonction PUR. Utilise exactement la même découpe "consulte la ligne entière"
 * que stripAlternateLinksFromBlock() : un `xhtml:link` qui occupe sa propre
 * ligne emporte SON indentation et SON saut de ligne, sinon on laisserait des
 * lignes vides. Un bloc dont la liste obtenue est déjà identique est renvoyé à
 * l'octet près (`changed:false`) — c'est ce qui rend la réconciliation
 * idempotente et donc sans écriture inutile.
 *
 * @param {string} block
 * @param {string[]} lignes `xhtml:link` déjà rendus, indentés
 * @return {{block:string, changed:boolean}}
 */
function replaceAlternateLinksInBlock(block, lines) {
  var re = /<xhtml:link\b[^>]*\/>/g;
  var cuts = [];
  var m;
  while ((m = re.exec(block)) !== null) {
    var start = m.index;
    var end = m.index + m[0].length;
    var lineStart = block.lastIndexOf('\n', start - 1) + 1;
    var nlAfter = block.indexOf('\n', end);
    var tail = block.slice(end, nlAfter === -1 ? block.length : nlAfter);
    if (/^[ \t]*$/.test(block.slice(lineStart, start)) && /^[ \t]*$/.test(tail)) {
      start = lineStart;
      if (nlAfter !== -1) end = nlAfter + 1;
    } else {
      var ws = /[ \t]+$/.exec(block.slice(0, start));
      if (ws) start -= ws[0].length;
    }
    cuts.push({ start: start, end: end });
  }

  var stripped = '';
  var cursor = 0;
  cuts.forEach(function (cut) {
    stripped += block.slice(cursor, cut.start);
    cursor = cut.end;
  });
  stripped += block.slice(cursor);

  var wanted = (Array.isArray(lines) ? lines : []).join('\n');
  if (!wanted) return { block: stripped, changed: stripped !== block };

  // Production : bloc multi-ligne, liens sur leurs propres lignes en fin d'entrée
  // (dernier enfant de `<url>`). Entrée historique inline : liens collés à
  // `</url>`, comme le fait déjà stripAlternateLinksFromBlock().
  var rebuilt = stripped.indexOf('\n') !== -1
    ? stripped.replace(/([ \t]*)<\/url>$/, function (_, indent) { return wanted + '\n' + indent + '</url>'; })
    : stripped.replace(/<\/url>$/, wanted.replace(/\n\s*/g, '') + '</url>');

  return { block: rebuilt, changed: rebuilt !== block };
}

/**
 * Rétablit la RÉCIPROCITÉ des hreflang d'un groupe de traduction.
 *
 * Fonction PUR. Publier une nouvelle traduction AJOUTE son entrée au sitemap,
 * mais les entrées des traductions DÉJÀ présentes continueraient de ne pas la
 * citer : Google exigerait alors des liens réciproques et le groupe serait
 * ignoré. Chaque `<url>` du groupe est donc réécrite avec la liste EXACTE des
 * alternats publiés ; TOUS les autres octets du document — y compris les autres
 * groupes et une retouche manuelle — sont renvoyés à l'identique.
 *
 * @param {string} xml sitemap
 * @param {string[]} locs URLs ABSOLUES des entrées du groupe, toutes langues
 * @param {Array<{lang:string,url:string}>} alternates
 * @return {{ok:boolean, html:string, changed:boolean, touched:number}}
 */
function reconcileSitemapAlternates(xml, locs, alternates) {
  var source = String(xml || '');
  var targets = {};
  (Array.isArray(locs) ? locs : []).forEach(function (l) {
    if (l) targets[String(l)] = true;
  });
  var wanted = Array.isArray(alternates) ? alternates : [];
  if (!Object.keys(targets).length || !wanted.length) {
    return { ok: true, html: source, changed: false, touched: 0 };
  }

  var lines = wanted.map(function (alt) {
    return '    <xhtml:link rel="alternate" hreflang="' + escHtml(alt.lang) +
      '" href="' + escHtml(alt.url) + '"/>';
  });

  var touched = 0;
  var patched = source.replace(/<url>[\s\S]*?<\/url>/g, function (block) {
    var loc = /<loc>([^<]*)<\/loc>/.exec(block);
    if (!loc || !targets[loc[1]]) return block;
    var result = replaceAlternateLinksInBlock(block, lines);
    if (result.changed) touched += 1;
    return result.block;
  });

  return {
    ok: true,
    html: touched ? patched : source,
    changed: touched > 0,
    touched: touched
  };
}

/* ------------------------------------------------------------------------ */
/* Identité de ligne et traductions survivantes (suppression)                 */
/* ------------------------------------------------------------------------ */

/**
 * Deux lignes `Articles` désignent-elles le même article ?
 *
 * Fonction PUR. L'ID prime quand les deux sont renseignés — c'est la clé de la
 * feuille. À défaut (ligne de fixture, colonne vide), on retombe sur
 * LANG+SLUG, qui est l'identité du chemin publié. Une suppression ne doit
 * JAMAIS masquer une autre ligne que celle visée.
 *
 * @param {Object} a
 * @param {Object} b
 * @return {boolean}
 */
function sameArticleRow(a, b) {
  var aId = String(a && a.ID !== null && a.ID !== undefined ? a.ID : '').trim();
  var bId = String(b && b.ID !== null && b.ID !== undefined ? b.ID : '').trim();
  if (aId && bId) return aId === bId;
  return String(a && a.LANG ? a.LANG : '').trim() === String(b && b.LANG ? b.LANG : '').trim() &&
    String(a && a.SLUG ? a.SLUG : '').trim() === String(b && b.SLUG ? b.SLUG : '').trim();
}

/**
 * Traductions PUBLIÉES d'un article supprimé, hors article lui-même.
 *
 * Fonction PUR. Réutilise `publishedTranslations()` du moteur de rendu : le
 * groupe, le filtre sur le statut et l'exclusion de l'article courant suivent
 * donc exactement les mêmes règles que les hreflangs de la page. Un tableau
 * `null` (lecture impossible) ne produit AUCUNE traduction : mieux vaut laisser
 * les entrées restantes intactes que deviner.
 *
 * @param {Object} article ligne `Articles` visée par la suppression
 * @param {Array<Object>|null} published
 * @return {Array<Object>}
 */
function survivingTranslations(article, published) {
  if (!Array.isArray(published)) return [];
  return publishedTranslations({
    lang: String(article && article.LANG ? article.LANG : '').trim(),
    slug: String(article && article.SLUG ? article.SLUG : '').trim(),
    group: String(article && article.TRANSLATION_GROUP ? article.TRANSLATION_GROUP : '').trim() ||
      String(article && article.SLUG ? article.SLUG : '').trim()
  }, published);
}

/**
 * Écriture d'un index PARTAGÉ, avec retry borné sur conflit de SHA.
 *
 * `articles.json` et `sitemap.xml` sont écrits par TOUS les articles : c'est
 * donc sur ces deux fichiers que se disputent les publications. Un 409 signifie
 * « le dépôt a bougé entre ma lecture et mon écriture » — un état déjà résolu
 * côté dépôt, qu'un retry borné suffit à rattraper, et non une panne. Sans ce
 * retry, l'opérateur devrait republier sa ligne à la main pour un conflit qui ne
 * le concerne pas.
 *
 * `stager(content)` est RÉÉVALUÉ après la relecture : le contenu distant a pu
 * changer entre-temps, et rejouer un patch calculé sur la version précédente
 * ÉCRASERAIT la publication concurrente.
 *
 * @param {string} path chemin REPO de l'index
 * @param {function(string):{ok:boolean, html?:string, changed?:boolean, error?:string}} stager
 *        prépare le contenu à partir de l'état DISTANT courant
 * @param {string} message message de commit
 * @return {{ok:boolean, path:string, changed:boolean, sha:string, existed:boolean,
 *           retried:boolean, staged:Object}}
 */
function writeSharedIndex(path, stager, message) {
  var existing = getFile(path);
  var existed = !!existing;
  var staged = stager(existing ? existing.content : '');
  if (!staged || staged.ok !== true) {
    return {
      ok: false, path: path, changed: false, sha: '', existed: existed, retried: false, staged: staged || {},
      error: path + ' : ' + ((staged && staged.error) || 'préparation impossible')
    };
  }
  if (!staged.changed) {
    return {
      ok: true, path: path, changed: false, sha: existed ? existing.sha : '', existed: existed,
      retried: false, staged: staged
    };
  }

  try {
    var written = createOrUpdate({
      path: path, content: staged.html, message: message,
      sha: existed ? existing.sha : '', action: existed ? 'update' : 'create'
    });
    return { ok: true, path: path, changed: true, sha: written.sha, existed: existed, retried: false, staged: staged };
  } catch (e) {
    if (!isShaConflict(e) || PUBLISH_CONFLICT_RETRIES < 1) throw e;
  }

  var fresh = getFile(path);
  var again = stager(fresh ? fresh.content : '');
  if (!again || again.ok !== true) {
    return {
      ok: false, path: path, changed: false, sha: '', existed: !!fresh, retried: true, staged: again || {},
      error: path + ' : ' + ((again && again.error) || 'recalcul impossible après conflit de SHA')
    };
  }
  if (!again.changed) {
    // L'autre publication avait déjà écrit exactement ce qu'on allait écrire.
    return { ok: true, path: path, changed: false, sha: fresh ? fresh.sha : '', existed: !!fresh, retried: true, staged: again };
  }
  var retried = createOrUpdate({
    path: path, content: again.html, message: message,
    sha: fresh ? fresh.sha : '', action: fresh ? 'update' : 'create'
  });
  return { ok: true, path: path, changed: true, sha: retried.sha, existed: !!fresh, retried: true, staged: again };
}

/* ------------------------------------------------------------------------ */
/* Retrait (idempotent, retry 409 borné)                                       */
/* ------------------------------------------------------------------------ */

/**
 * Moteur d'écriture commun aux 3 retraits : lit, applique `patchFn`, réécrit
 * UNIQUEMENT si le contenu a changé.
 *
 * Reprend le motif de conflit de upsertArticleInIndexFile() : PUT → 409 →
 * relecture → recalcul sur le contenu FRAIS → un seul nouvel essai. Le SHA
 * transporté par le retry est celui RELU, jamais celui du conflit.
 *
 * `patchFn(content)` doit renvoyer `{ok, html, changed, …}` sans jamais
 * effectuer d'écriture : c'est ce qui rend chaque étape testable et
 * rejouable. Aucun commit n'est créé si `changed === false`.
 *
 * @param {string} path
 * @param {Function} patchFn (content:string) => Object
 * @param {string} [message] message de commit déterministe
 */
function patchIndexFile(path, patchFn, message) {
  var existing;
  try {
    existing = getFile(path);
  } catch (e) {
    return { ok: false, path: path, changed: false, error: 'Lecture impossible de ' + path + ' : ' + redact(String(e && e.message ? e.message : e)) };
  }
  if (!existing) {
    // Un index absent n'est jamais CRÉÉ par une suppression : il n'y a rien à
    // retirer, et recréer un fichier serait une écriture non demandée.
    return { ok: true, path: path, changed: false, removed: false, absent: true, count: 0 };
  }

  var patched = patchFn(existing.content);
  if (!patched || patched.ok !== true) {
    return { ok: false, path: path, changed: false, error: path + ' : ' + ((patched && patched.error) || 'retrait impossible') };
  }
  if (!patched.changed) {
    return {
      ok: true, path: path, changed: false, removed: false,
      sha: existing.sha, count: typeof patched.count === 'number' ? patched.count : countArticleItems(existing.content)
    };
  }

  var commit = message || ('Retrait : ' + path);
  try {
    var written = createOrUpdate({
      path: path,
      content: patched.html,
      message: commit,
      sha: existing.sha,
      action: 'update'
    });
    return {
      ok: true, path: path, changed: true, removed: true, sha: written.sha,
      count: typeof patched.count === 'number' ? patched.count : countArticleItems(patched.html)
    };
  } catch (e) {
    if (!isShaConflict(e) || PUBLISH_CONFLICT_RETRIES < 1) {
      return { ok: false, path: path, changed: false, error: path + ' : ' + redact(String(e && e.message ? e.message : e)) };
    }
    var fresh;
    try {
      fresh = getFile(path);
    } catch (readError) {
      return { ok: false, path: path, changed: false, error: path + ' : ' + redact(String(readError && readError.message ? readError.message : readError)) };
    }
    if (!fresh) return { ok: true, path: path, changed: false, removed: false, absent: true, count: 0 };
    var again = patchFn(fresh.content);
    if (!again || again.ok !== true) {
      return { ok: false, path: path, changed: false, error: path + ' : ' + ((again && again.error) || 'retrait impossible après conflit de SHA') };
    }
    if (!again.changed) {
      return { ok: true, path: path, changed: false, removed: false, sha: fresh.sha, count: countArticleItems(fresh.content) };
    }
    var retried = createOrUpdate({
      path: path,
      content: again.html,
      message: commit,
      sha: fresh.sha,
      action: 'update'
    });
    return {
      ok: true, path: path, changed: true, removed: true, sha: retried.sha,
      count: typeof again.count === 'number' ? again.count : countArticleItems(again.html), retried: true
    };
  }
}

/**
 * Retrait dans un index de catégorie (wrapper nommé du plan, D5.8).
 *
 * `categoryName` n'est plus transmis à `removeFromCategoryList()` : le `<h2>`
 * n'est jamais retiré, donc l'intitulé de la catégorie n'a plus d'usage ici.
 * Le paramètre reste accepté (et ignoré) pour ne pas casser l'appelant.
 *
 * @param {string} path ex. blog/facturation/index.html
 * @param {string} href href EXACT de l'article
 * @param {{message?:string, categoryName?:string}} [meta]
 */
function removeArticleFromIndexFile(path, href, meta) {
  var info = meta || {};
  return patchIndexFile(path, function (content) {
    return removeFromCategoryList(content, href);
  }, info.message || ('Index : retrait de ' + href));
}

/* ------------------------------------------------------------------------ */
/* Orchestration du retrait des 4 index                                      */
/* ------------------------------------------------------------------------ */

/**
* Retire les références statiques d'un article : articles.json → sitemap.
 * SÉQUENCE STRICTE, identique en lecture et en écriture. L'index de catégorie
 * (qui n'existe pas) est traité avant, et le hub (dynamique) jamais.
 *
 * Appelé UNIQUEMENT par Publisher.gs, et UNIQUEMENT après le contrôle d'identité
 * et le contrôle du SHA distant, et AVANT la suppression du fichier article :
 * c'est ce qui rend l'état « index à jour + fichier supprimé » inatteignable.
 *
 * AUCUN échec ne remonte en exception. Chaque étape est isolée : l'échec du
 * sitemap n'annule pas articles.json. Les avertissements sont
 * remontés dans `warnings` (donc dans le résultat, le compte rendu opérateur et
 * la feuille Logs).
 *
 * @param {Object} article ligne `Articles`
 * @param {{href:string, categorySlug:string, categoryName?:string, slug?:string}} options
 * @return {{ok:boolean, removed:boolean, steps:Object, warnings:Array, writes:number}}
 */
function removeIndexesForArticle(article, options) {
  var opt = options || {};
  var warnings = [];
  var href = String(opt.href || '');
  var categorySlug = String(opt.categorySlug || '').trim();
  var categoryName = String(opt.categoryName || '');
  var slug = String(opt.slug || (article && article.SLUG) || '');

  var report = {
    ok: true,
    removed: false,
    writes: 0,
    categoryIndex: { path: '', changed: false, removed: false },
    hub: { path: BLOG_HUB_PATH, changed: false, removed: false },
    sitemap: { path: APP.SITEMAP_PATH, changed: false, removed: false },
    articlesIndex: { path: APP.ARTICLES_INDEX_PATH, changed: false, removed: false },
    warnings: warnings
  };

  if (!href || !categorySlug) {
    report.ok = false;
    warnings.push({ code: 'RX0', message: 'Retrait impossible : href ou catégorie absent.' });
    return report;
  }

  /* --- Lecture des lignes PUBLIÉES (étapes 3 et 4) ----------------------- */
  // UNE SEULE lecture pour les deux étapes, faite ICI et pas dans l'une
  // d'elles : les étapes 3 et 4 utilisent cette même liste, donc elle doit
  // exister avant les deux. La lire dans l'étape 3 la rendait `undefined`
  // pour l'étape 4 (déclarée par `var` plus bas) — donc articles.json se
  // vidait de TOUS ses articles au premier retrait réussi, sans aucun avertissement.
  //
  // Si la lecture échoue, les traductions survivantes sont inconnues : les
  // entrées restantes gardent alors leur `x-default` (étape 4 inoffensive) et
  // articles.json est déclaré en retard (étape 3) — jamais une reconstruction à
  // l'aveugle.
  var allRows = null;
  if (Array.isArray(opt.published)) allRows = opt.published;
  else {
    try { allRows = readArticles(); } catch (e) { allRows = null; }
  }

  var survivors = survivingTranslations(article, allRows);
  var survivorLangs = {};
  survivors.forEach(function (row) {
    survivorLangs[String(row.LANG || '').trim()] = APP.SITE_ORIGIN + sitePath(String(row.LANG || '').trim(), String(row.SLUG || '').trim());
  });

  /* --- 1. Index de catégorie --------------------------------------------- */
  var categoryPath = APP.BLOG_DIR + '/' + categorySlug + '/index.html';
  report.categoryIndex.path = categoryPath;
  var category = removeArticleFromIndexFile(categoryPath, href, {
    categoryName: categoryName,
    message: 'Index : retrait de ' + slug + ' (' + categorySlug + ')'
  });
  if (!category.ok) {
    report.ok = false;
    report.categoryIndex.error = category.error;
    warnings.push({ code: 'RX1', message: 'Index de catégorie : ' + category.error });
  } else {
    report.categoryIndex = category;
    if (category.changed) { report.removed = true; report.writes += 1; }
    // Catégorie désormais vide : signalée, jamais supprimée.
    if (category.removed && category.count === 0) {
      warnings.push({
        code: 'CATEGORY_COUNT_EMPTY',
        message: 'Index de catégorie « ' + categoryPath + ' » désormais vide. ' +
          'La catégorie et son index sont CONSERVés : leur suppression reste une décision éditoriale.'
      });
    }
  }

  /* --- 2. Hub Blog ------------------------------------------------------ */
  // Compteur = total RÉEL de l'INDEX DE CATÉGORIE (étape 1), jamais de la liste
  // du hub : le hub ne liste qu'une sélection d'articles. Si l'étape 1 a
  // échoué, on ne touche à AUCUN compteur (updateCategoryCounts() refuse
  // d'écrire sans source de vérité — « aucun compteur fourni »).
  var countedMap = {};
  var haveCount = category.ok && !category.absent && typeof category.count === 'number';
  if (haveCount) countedMap[categorySlug] = category.count;
  var hubIsDynamic = false;
  try {
    var hub = patchIndexFile(BLOG_HUB_PATH, function (content) {
      // Hub RENDU À L'EXÉCUTION (voir updateIndexesForArticle) : aucune liste
      // statique à retirer, et retirer une carte qui n'existe pas ne serait
      // qu'une écriture sans effet. La source de vérité est articles.json,
      // retraitée à l'étape 3.
      if (content.indexOf(BLOG_LIST_OPEN) === -1) {
        hubIsDynamic = true;
        return { ok: true, html: content, changed: false };
      }
      return removeFromHub(content, href, categorySlug, haveCount ? category.count : undefined);
    }, 'Hub : retrait de ' + slug);
    if (!hub.ok) {
      report.ok = false;
      report.hub.error = hub.error;
      warnings.push({ code: 'RX2', message: 'Hub Blog : ' + hub.error });
    } else {
      if (hubIsDynamic) hub.action = 'dynamic';
      report.hub = hub;
      if (hub.changed) { report.removed = true; report.writes += 1; }
    }
  } catch (e) {
    report.ok = false;
    report.hub.error = redact(String(e && e.message ? e.message : e));
    warnings.push({ code: 'RX2', message: 'Hub Blog : ' + report.hub.error });
  }

  /* --- 3. articles.json ------------------------------------------------- */
  try {
    var rest = (allRows || []).filter(function (row) {
      return !sameArticleRow(row, article);
    });

    // Même règle qu'à la publication : le tampon n'est renouvelé que si la liste
    // change. Un retrait déjà effectué ne réécrit donc rien. Le contenu lu par
    // patchIndexFile() est réutilisé : aucune lecture GitHub supplémentaire.
    var jsonStep = patchIndexFile(APP.ARTICLES_INDEX_PATH, function (content) {
      var built = buildArticlesIndexJson(rest, articlesIndexStamp(rest, nowIso(), content));
      if (!built.ok) return { ok: false, error: built.error };
      return { ok: true, html: built.json, changed: built.json !== content, count: built.count };
    }, 'articles.json : retrait de ' + slug);
    if (!jsonStep.ok) {
      report.ok = false;
      report.articlesIndex.error = jsonStep.error;
      warnings.push({ code: 'RX3', message: 'articles.json : ' + jsonStep.error });
    } else {
      report.articlesIndex = jsonStep;
      if (jsonStep.changed) { report.removed = true; report.writes += 1; }
    }
  } catch (e) {
    report.ok = false;
    report.articlesIndex.error = redact(String(e && e.message ? e.message : e));
    warnings.push({ code: 'RX3', message: 'articles.json : ' + report.articlesIndex.error });
  }

  /* --- 4. Sitemap ------------------------------------------------------- */
  // Retirer l'entrée de l'URL supprimée ne suffit pas : les entrées des
  // TRADUCTIONS RESTANTES porteraient un `hreflang` vers une page 404. Les
  // deux opérations sont donc appliquées dans le MÊME patchIndexFile(), donc
  // une seule lecture et une seule écriture, et l'alternate `x-default` est
  // réparé au passage (français du groupe s'il survit, sinon l'entrée elle-même).
  var deadLoc = APP.SITE_ORIGIN + href;

  try {
    var sitemap = patchIndexFile(APP.SITEMAP_PATH, function (content) {
      var dropped = removeFromSitemap(content, deadLoc);
      if (!dropped.ok) return dropped;
      var cleaned = stripAlternatesFromSitemap(dropped.html, [deadLoc], survivorLangs);
      return {
        ok: true,
        html: cleaned.html,
        changed: dropped.changed || cleaned.changed,
        removed: dropped.removed
      };
    }, 'Sitemap : retrait de ' + slug);
    if (!sitemap.ok) {
      report.ok = false;
      report.sitemap.error = sitemap.error;
      warnings.push({ code: 'RX4', message: 'Sitemap : ' + sitemap.error });
    } else {
      report.sitemap = sitemap;
      if (sitemap.changed) { report.removed = true; report.writes += 1; }
    }
  } catch (e) {
    report.ok = false;
    report.sitemap.error = redact(String(e && e.message ? e.message : e));
    warnings.push({ code: 'RX4', message: 'Sitemap : ' + report.sitemap.error });
  }

  if (!report.ok) {
    // MÊME chemin de journalisation que le reste du flux de suppression :
    // `logWarning()` laisserait la colonne dédiée GITHUB_PATH vide et
    // disperserait le chemin dans DETAILS, alors que la valeur EST connue ici.
    // `logDeleteEvent()` (Publisher.gs) est le helper D5 unique : on le
    // réutilise, on n'en crée pas un second, et `Logger.gs` reste intact.
    logDeleteEvent(LEVEL.WARNING, 'Index Blog partiellement nettoyé avant suppression.', {
      articleId: article && article.ID,
      slug: slug,
      status: article && article.STATUS,
      githubPath: article && article.GITHUB_PATH,
      details: {
        warnings: warnings.length,
        codes: warnings.map(function (w) { return w.code; }),
        writes: report.writes
      }
    });
  }

  return report;
}
