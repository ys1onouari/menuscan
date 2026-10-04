/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Renderer.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : produire le HTML final d'un article à partir du
 * gabarit `blog/template-article.html` et d'une ligne `Articles`.
 *
 * PUR (Phase 3) :
 *   - aucune écriture GitHub, aucun appel réseau, aucun accès Sheets en lecture
 *     hormis resolveCategory() (table de catégories, D2) ;
 *   - le gabarit n'est JAMAIS modifié : c'est la SORTIE qui reçoit le
 *     post-traitement de profondeur (D3) ;
 *   - validateRenderedHtml() est appelé AVANT de rendre le résultat : aucune
 *     publication future ne peut ignorer le contrat de production.
 *
 * Le commentaire de développement du gabarit est CONSERVÉ dans la page
 * publiée : la substitution l'ignore (htmlCommentRanges) et il documente le
 * gabarit sur GitHub.
 *
 * Modèle SEO à 10 champs (PO-1)
 * ---------------------------------------------------------------------------
 * La mesure du socle de production montre que les dix chaînes éditoriales sont
 * INDÉPENDANTES et NON déductibles les unes des autres. Chaque emplacement est
 * donc un SLOT explicite, résolu par une chaîne de sources ordonnée et
 * surchargeable via `options.seo` :
 *
 *   1  pageTitle         <title>                          SEO_TITLE
 *   2  headline          <h1>                             TITLE
 *   3  ogTitle           og:title                         OG_TITLE
 *   4  twitterTitle      twitter:title                    TWITTER_TITLE
 *   5  jsonLdHeadline    JSON-LD "headline"               JSONLD_HEADLINE
 *   6  breadcrumbTitle   fil d'Ariane + JSON-LD ListItem  BREADCRUMB_TITLE
 *   7  metaDescription   meta description                 META_DESCRIPTION
 *   8  ogDescription     og:description                   OG_DESCRIPTION
 *   9  twitterDescription twitter:description             TWITTER_DESCRIPTION
 *  10  jsonLdDescription JSON-LD "description"            JSONLD_DESCRIPTION
 *
 * Suffixe de marque : appliqué au SEUL <title> (9/9 en production), JAMAIS
 * aux autres emplacements, et JAMAIS en double. Source : BRAND_SUFFIX (Utils).
 */

/** Placeholders dont la valeur est du HTML de confiance (jamais échappé). */
var RAW_HTML_PLACEHOLDERS = [
  'TOC_ITEMS', 'ARTICLE_BODY', 'FAQ_SECTION', 'CTA_BLOCK',
  'RELATED_ARTICLES', 'PREV_LINK', 'NEXT_LINK',
  'HREFLANG_LINKS', 'TRANSLATION_LINKS'
];

/**
 * Chaînes de sources par emplacement, dans l'ordre de priorité décroissante.
 * `__seo.<slot>` (surcharge d'appel) reste prioritaire sur la colonne.
 */
var SEO_SLOT_SOURCES = {
  pageTitle: ['SEO_TITLE', 'TITLE'],
  headline: ['TITLE', 'SEO_TITLE'],
  ogTitle: ['OG_TITLE', 'SEO_TITLE', 'TITLE'],
  twitterTitle: ['TWITTER_TITLE', 'OG_TITLE', 'SEO_TITLE', 'TITLE'],
  jsonLdHeadline: ['JSONLD_HEADLINE', 'TITLE', 'SEO_TITLE'],
  breadcrumbTitle: ['BREADCRUMB_TITLE', 'TWITTER_TITLE', 'TITLE', 'SEO_TITLE'],
  metaDescription: ['META_DESCRIPTION', 'SOCIAL_DESCRIPTION'],
  ogDescription: ['OG_DESCRIPTION', 'SOCIAL_DESCRIPTION', 'META_DESCRIPTION'],
  twitterDescription: ['TWITTER_DESCRIPTION', 'OG_DESCRIPTION', 'SOCIAL_DESCRIPTION', 'META_DESCRIPTION'],
  jsonLdDescription: ['JSONLD_DESCRIPTION', 'OG_DESCRIPTION', 'SOCIAL_DESCRIPTION', 'META_DESCRIPTION'],
  articleExcerpt: ['ARTICLE_EXCERPT', 'META_DESCRIPTION']
};

/** Emplacements portant le suffixe de marque : le <title> et lui seul. */
var SUFFIXED_SLOTS = ['pageTitle'];

/**
 * Règles d'ancrage des `{{TITLE}}` (7 occurrences, 6 sens distincts).
 * L'ancre la plus longue gagne ; une occurrence non reconnue est une ERREUR,
 * jamais un repli silencieux.
 */
var TITLE_SITE_RULES = [
  { slot: 'pageTitle', anchor: '<title>', mode: 'html' },
  { slot: 'ogTitle', anchor: '<meta property="og:title" content="', mode: 'html' },
  { slot: 'twitterTitle', anchor: '<meta name="twitter:title" content="', mode: 'html' },
  { slot: 'jsonLdHeadline', anchor: '"headline": "', mode: 'json' },
  { slot: 'breadcrumbTitle', anchor: '"name": "', mode: 'json' },
  { slot: 'headline', anchor: '<h1>', mode: 'html' },
  { slot: 'breadcrumbTitle', anchor: '<span>', mode: 'html' }
];

/** Règles d'ancrage des `{{DESCRIPTION}}` (5 occurrences, 5 sens distincts). */
var DESCRIPTION_SITE_RULES = [
  { slot: 'metaDescription', anchor: '<meta name="description" content="', mode: 'html' },
  { slot: 'ogDescription', anchor: '<meta property="og:description" content="', mode: 'html' },
  { slot: 'twitterDescription', anchor: '<meta name="twitter:description" content="', mode: 'html' },
  { slot: 'jsonLdDescription', anchor: '"description": "', mode: 'json' },
  { slot: 'articleExcerpt', anchor: '<p class="article-excerpt">', mode: 'html' }
];

/**
 * Racines d'assets du gabarit, réécrites avec UN « ../ » à la sortie.
 * L'article vit dans /blog/{lang}/ : le préfixe est donc unique et le gabarit
 * n'en porte aucun. Les chemins ABSOLUS du site (/apple-touch-icon.png,
 * https://fonts…) ne sont jamais concernés.
 */
var DEPTH_ONE_ASSET_ROOTS = ['assets', 'css', 'js', 'icons', 'fonts'];

/**
 * Erreur portant son CODE de contrat.
 * Le moteur s'appuie sur `e.code` pour distinguer une violation de gabarit
 * (R5b) d'une substitution impossible (R5) : sans cela, un gabarit|altéré
 * serait diagnosticé à tort comme un problème de données.
 */
function codedError(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/* -------------------------------------------------------------------------- */
/* Modèle SEO                                                                 */
/* -------------------------------------------------------------------------- */

/** true si `value` porte déjà le suffixe de marque. */
function hasBrandSuffix(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  return s.length > 0 && s.slice(-BRAND_SUFFIX.length) === BRAND_SUFFIX;
}

/**
 * Ajoute le suffixe de marque une SEULE fois.
 * Un suffixe déjà présent n'est jamais dupliqué (garde « suffix-prevention »).
 */
function withBrandSuffix(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return '';
  return hasBrandSuffix(s) ? s : s + BRAND_SUFFIX;
}

/**
 * Construit le modèle SEO à 10 champs.
 *
 * @param {Object} article  ligne `Articles` (lu par en-tête)
 * @param {{seo?:Object}} [options]
 * @return {{values:Object, sources:Object, missing:string[], warnings:Object[]}}
 */
function buildSeoModel(article, options) {
  var opts = options || {};
  var overrides = opts.seo || {};
  var values = {};
  var sources = {};
  var missing = [];
  var warnings = [];

  Object.keys(SEO_SLOT_SOURCES).forEach(function (slot) {
    var chosen = '';
    var origin = '';

    // 1) surcharge d'appel — elle seule peut porter une valeur absente de la ligne
    if (String(overrides[slot] === null || overrides[slot] === undefined ? '' : overrides[slot]).trim() !== '') {
      chosen = String(overrides[slot]).trim();
      origin = 'options.seo.' + slot;
    }

    // 2) colonnes de la ligne, pilotées par l'en-tête
    if (!chosen) {
      var chain = SEO_SLOT_SOURCES[slot];
      for (var i = 0; i < chain.length; i++) {
        var candidate = String(article[chain[i]] === null || article[chain[i]] === undefined ? '' : article[chain[i]]).trim();
        if (candidate) {
          chosen = candidate;
          origin = chain[i];
          break;
        }
      }
    }

    // 3) repli déterministe sur un emplacement déjà résolu
    if (!chosen) {
      chosen = fallbackForSlot(slot, values);
      if (chosen) origin = 'repli:' + slot;
    }

    if (!chosen) {
      missing.push(slot);
      return;
    }

    values[slot] = SUFFIXED_SLOTS.indexOf(slot) !== -1 ? withBrandSuffix(chosen) : chosen;
    sources[slot] = origin;

    // Traçabilité : un emplacement qui retombe sur une chaîne secondaire est
    // signalé, car la valeur production peut alors diverger.
    var first = SEO_SLOT_SOURCES[slot][0];
    if (origin !== first && origin.indexOf('repli:') === 0) {
      warnings.push({
        code: 'R1x',
        message: 'Slot « ' + slot + ' » sans colonne dédiée ni surcharge : repli sur « ' +
          origin.replace('repli:', '') + ' »'
      });
    }
  });

  return { values: values, sources: sources, missing: missing, warnings: warnings };
}

/** Repli d'un emplacement sur un emplacement déjà résolu (ordre stable). */
function fallbackForSlot(slot, values) {
  switch (slot) {
    case 'pageTitle': return values.headline || '';
    case 'ogTitle': return values.pageTitle || '';
    case 'twitterTitle': return values.ogTitle || values.headline || '';
    case 'jsonLdHeadline': return values.headline || values.pageTitle || '';
    case 'breadcrumbTitle': return values.twitterTitle || values.headline || '';
    case 'ogDescription': return values.metaDescription || '';
    case 'twitterDescription': return values.ogDescription || values.metaDescription || '';
    case 'jsonLdDescription': return values.ogDescription || values.metaDescription || '';
    case 'articleExcerpt': return values.metaDescription || '';
    default: return '';
  }
}

/* -------------------------------------------------------------------------- */
/* Sous-blocs de contenu                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Normalise un temps de lecture éditorial (PO-2).
 * Accepte « 8 », « 8 min », « 8 minutes », 8. Le gabarit porte déjà
 * « min de lecture » : seule la valeur numérique est substituée.
 * Ne recalcule JAMAIS la durée à partir du contenu.
 *
 * @return {{value:string, error:string}}
 */
function normalizeReadingTime(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return {
      value: '',
      error: 'READING_TIME absent : durée de lecture éditoriale obligatoire ' +
        '(PO-2 — le moteur ne la calcule jamais). Fournir la colonne READING_TIME.'
    };
  }
  var m = /(\d+)/.exec(String(raw));
  if (!m) {
    return {
      value: '',
      error: 'READING_TIME illisible : « ' + String(raw) + ' » (attendu un nombre de minutes)'
    };
  }
  var n = parseInt(m[1], 10);
  if (n < 1 || n > 999) {
    return { value: '', error: 'READING_TIME hors bornes (1-999) : ' + n };
  }
  return { value: String(n), error: '' };
}

/**
 * Détecte la convention de fin de ligne d'un fragment.
 * Le gabarit et les articles publiés sont en CRLF : les blocs générés doivent
 * l'être aussi, sinon la sortie mélange les deux conventions.
 */
function detectNewline(text) {
  return /\r\n/.test(String(text || '')) ? '\r\n' : '\n';
}

/** Normalise les fins de ligne d'un fragment généré. */
function withNewline(value, newline) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n|\n|\r/g, newline || '\n');
}

/**
 * Bloc FAQ : `<div class="b-faq">` + un `<details>` par question.
 * Le markup est ENTIÈREMENT produit par le moteur à partir d'objets
 * structurés {q, a} : aucune saisie HTML brute n'est acceptée, donc aucun
 * script ni attribut `on*` ne peut entrer par cette voie.
 * Aucun contenu ⇒ chaîne vide (le bloc disparaît, comme en production sans FAQ).
 *
 * @param {{q:string,a:string}|Array} faq
 * @param {{heading?:string, newline?:string}} [opt]
 * @return {string} HTML de confiance
 */
function buildFaqSection(faq, opt) {
  var opts = opt || {};
  var items = [];
  if (Array.isArray(faq)) items = faq;
  else if (faq && (faq.q || faq.question)) items = [faq];

  var entries = [];
  items.forEach(function (item) {
    var question = String(item.q === undefined ? (item.question || '') : (item.q || '')).trim();
    var answer = String(item.a === undefined ? (item.answer || '') : (item.a || '')).trim();
    if (question && answer) entries.push([question, answer]);
  });
  if (!entries.length) return '';

  var heading = String(opts.heading || '').trim() || 'FAQ';
  var out = ['<div class="b-faq">',
    '  <h2 id="faq">' + escHtml(heading) + '</h2>'];
  entries.forEach(function (entry) {
    out.push('  <details>',
      '    <summary>' + escHtml(entry[0]) + '</summary>',
      '    <p>' + escHtml(entry[1]) + '</p>',
      '  </details>');
  });
  out.push('</div>');
  return withNewline(out.join('\n'), opts.newline);
}

/**
 * Garantit un `id` UNIQUE et stable sur chaque titre h2/h3 du corps.
 *
 * Le sommaire pointe par id : un titre sans id serait invisible dans la table
 * des matières, et un id dupliqué(pointant le mauvais titre) produirait un
 * sommaire faux. L'id est donc déduit du TEXTE du titre, les collisions étant
 * suffixées (-2, -3…). Un id déjà présent et valide est conservé tel quel :
 * l'auteur garde la main sur ses ancres.
 *
 * @param {string} body HTML de confiance
 * @return {{body:string, changed:boolean}}
 */
function ensureHeadingIds(body) {
  var source = String(body || '');
  var used = {};
  var re = /<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
  var out = '';
  var last = 0;
  var m;
  var changed = false;
  var unnamed = 0;

  while ((m = re.exec(source)) !== null) {
    var attrs = m[2] || '';
    var inner = m[3];
    var existing = /\sid="([^"]*)"/i.exec(attrs);
    var id = existing ? existing[1] : slugify(headingText(inner));
    // Un titre en arabe (ou tout texte sans caractère latin) ne produit aucun
    // slug : on lui attribue un identifiant positionnel stable, sinon il
    // disparaîtrait de la table des matières.
    if (!id) {
      unnamed += 1;
      id = 'section-' + unnamed;
    }
    var base = id;
    var n = 1;
    while (used[id]) { n += 1; id = base + '-' + n; }
    used[id] = true;

    if (existing && id === existing[1]) continue;

    changed = true;
    out += source.slice(last, m.index);
    var newAttrs = existing
      ? attrs.replace(/\sid="[^"]*"/i, ' id="' + escHtml(id) + '"')
      : ' id="' + escHtml(id) + '"' + attrs;
    out += '<h' + m[1] + newAttrs + '>' + inner + '</h' + m[1] + '>';
    last = m.index + m[0].length;
  }
  out += source.slice(last);
  return { body: out, changed: changed };
}

/** Texte lisible d'un fragment (balises retirées, entités décodées). */
function headingText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sommaire : une entrée par titre (h2/h3) PORTAANT un id, dans l'ordre du
 * document, corps PUIS FAQ. Le gabarit fournit `<nav class="toc"><ol>`.
 *
 * @param {string} contentHtml  corps + FAQ (HTML de confiance)
 * @param {{newline?:string}} [opt]
 * @return {string} HTML de confiance
 */
function buildTocItems(contentHtml, opt) {
  var opts = opt || {};
  var items = [];
  var re = /<h([23])\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/gi;
  var m;
  while ((m = re.exec(String(contentHtml || ''))) !== null) {
    var label = headingText(m[3]);
    if (!label) continue;
    items.push('<li><a href="#' + escHtml(m[2]) + '">' + escHtml(label) + '</a></li>');
  }
  return withNewline(items.join('\n'), opts.newline);
}

/**
 * Bloc « Articles similaires » : `.b-related` + une entrée par article publié.
 * Le markup est produit par le moteur à partir de LIGNES PUBLIÉES : le titre
 * et l'URL viennent de la ligne, jamais d'une saisie HTML.
 * Aucun article => chaîne vide (le bloc disparaît).
 *
 * @param {Array<{title:string,path?:string,url?:string}>} related
 * @param {{heading?:string, newline?:string}} [opt]
 * @return {string} HTML de confiance
 */
function buildRelatedArticles(related, opt) {
  var opts = opt || {};
  if (!Array.isArray(related) || !related.length) return '';

  var entries = [];
  related.forEach(function (item) {
    var title = String(item.title || '').trim();
    var href = normalizeArticleHref(item.path || item.url);
    var known = entries.some(function (e) { return e.href === href; });
    if (title && href && !known) entries.push({ title: title, href: href });
  });
  if (!entries.length) return '';

  var heading = String(opts.heading || '').trim() || 'Articles similaires';
  var out = ['<div class="b-related">',
    '  <h2>' + escHtml(heading) + '</h2>',
    '  <ul>'];
  entries.forEach(function (entry) {
    out.push('    <li><a href="' + escHtml(entry.href) + '">' + escHtml(entry.title) + '</a></li>');
  });
  out.push('  </ul>', '</div>');
  return withNewline(out.join('\n'), opts.newline);
}

/**
 * Bloc d'appel à l'action : `.b-cta`.
 * Le texte est un libellé de site (Config.LABELS), traduit dans la langue de
 * l'article : aucune donnée n'est saisie ligne à ligne, donc le bloc ne peut
 * pas diverger d'une page à l'autre.
 *
 * @param {string} lang
 * @return {string} HTML de confiance
 */
function buildCtaBlock(lang) {
  var title = getLabelRaw('CTA_TITLE', lang);
  var text = getLabelRaw('CTA_TEXT', lang);
  var primary = getLabelRaw('CTA_PRIMARY', lang);
  var secondary = getLabelRaw('CTA_SECONDARY', lang);
  if (!title || !text || !primary || !secondary) {
    throw codedError('R6', 'Libelles CTA incomplets pour la langue « ' + lang + ' » (Config.LABELS)');
  }
  var out = ['<div class="b-cta">',
    '  <h2>' + escHtml(title) + '</h2>',
    '  <p>' + escHtml(text) + '</p>',
    '  <div class="b-cta-actions">',
    '    <a class="b-btn" href="' + escHtml(APP.WHATSAPP_URL) + '" target="_blank" rel="noopener">' +
      escHtml(primary) + '</a>',
    '    <a class="b-btn b-btn-ghost" href="' + escHtml(siteBlogRootPath()) + '">' +
      escHtml(secondary) + '</a>',
    '  </div>',
    '</div>'];
  return withNewline(out.join('\n'));
}

/**
 * Lignes PUBLIÉES partageant le groupe de traduction de l'article, hors
 * l'article lui-même. Seules les lignes exploitables (langue connue, slug
 * valide) sont retenues : une ligne brouillon ou abîmée ne doit pas produire
 * un lien.
 */
function publishedTranslations(article, published) {
  var rows = Array.isArray(published) ? published : [];
  var group = String(article.group || article.slug || '').trim();
  return rows.filter(function (row) {
    if (!isPublishable(row)) return false;
    var lang = String(row.LANG || '').trim();
    var slug = String(row.SLUG || '').trim();
    if (!isSupportedLang(lang) || !isValidSlug(slug)) return false;
    var rowGroup = String(row.TRANSLATION_GROUP || '').trim() || slug;
    return rowGroup === group && !(lang === article.lang && slug === article.slug);
  });
}

/**
 * Bloc hreflang : un `<link rel="alternate">` ABSOLU par langue publiée, plus
 * `x-default`. Absolument et non relatif : c'est la forme qu'exige Google.
 *
 * Les liens sont dérivés des AUTRES LIGNES PUBLIÉES du même groupe : une
 * langue non publiée ne produit aucun lien, donc jamais de `href=""`. Les
 * deux pages d'une paire étant produites du même ensemble de lignes, la
 * réciprocité est structurelle. Si aucune traduction FR n'est publiée,
 * `x-default` pointe sur l'article lui-même (sa langue), ce qui reste valide.
 *
 * @param {{lang:string, slug:string, group:string, sitePath:string}} article
 * @param {Array<Object>} published lignes PUBLIÉES du groupe (hors article)
 * @return {{html:string, links:Object<string,string>}}
 */
function buildHreflangLinks(article, published) {
  var links = {};
  publishedTranslations(article, published).forEach(function (row) {
    links[row.LANG] = buildSiteUrl(sitePath(row.LANG, row.SLUG));
  });
  links[article.lang] = buildSiteUrl(article.sitePath);
  links['x-default'] = links[APP.DEFAULT_LANG] || links[article.lang];

  var html = APP.SUPPORTED_LANGS.filter(function (code) {
    return Object.prototype.hasOwnProperty.call(links, code);
  }).map(function (code) {
    return '<link rel="alternate" hreflang="' + code + '" href="' + escHtml(links[code]) + '">';
  });
  html.push('<link rel="alternate" hreflang="x-default" href="' + escHtml(links['x-default']) + '">');

  return { html: withNewline(html.join('\n')), links: links };
}

/**
 * Sélecteur de langue : un lien par langue (fr/en/es/ar).
 *
 * Vers la traduction si elle est PUBLIÉE, sinon vers le hub filtré — jamais un
 * href vide. Les liens sont RELATIFS (hub et articles partagent l'origine) et
 * la langue courante porte `aria-current="true"`.
 *
 * @param {{lang:string, slug:string, group:string, sitePath:string}} article
 * @param {Array<Object>} published lignes PUBLIÉES du groupe (hors article)
 * @param {{newline?:string}} [opt]
 * @return {string} HTML de confiance
 */
function buildTranslationLinks(article, published, opt) {
  var opts = opt || {};
  var byLang = {};
  publishedTranslations(article, published).forEach(function (row) {
    byLang[row.LANG] = sitePath(row.LANG, row.SLUG);
  });

  var html = APP.SUPPORTED_LANGS.map(function (code) {
    var current = code === article.lang;
    var href = current
      ? article.sitePath
      : (byLang[code] || (siteHubPath() + '?lang=' + code));
    return '<a href="' + escHtml(href) + '" hreflang="' + code + '" lang="' + code + '"' +
      (current ? ' aria-current="true"' : '') + '>' + code.toUpperCase() + '</a>';
  });
  return withNewline(html.join('\n'), opts.newline);
}

/**
 * Lien précédent / suivant : `.b-pager-kind` + `.b-pager-title`.
 * Les libellés viennent de Config.LABELS, dans la langue de l'article : le
 * titre du voisin est la seule donnée variable.
 *
 * @param {{title:string,path?:string,url?:string}|null} neighbour
 * @param {'previous'|'next'} kind
 * @param {{lang?:string}} [opt]
 * @return {string} HTML de confiance
 */
function buildArticleLink(neighbour, kind, opt) {
  var opts = opt || {};
  if (!neighbour) return '';
  var title = String(neighbour.title || '').trim();
  var href = normalizeArticleHref(neighbour.path || neighbour.url);
  if (!title || !href) return '';

  var labelKey = kind === 'previous' ? 'PAGER_PREV_KIND' : 'PAGER_NEXT_KIND';
  var label = getLabelRaw(labelKey, opts.lang);
  if (!label) {
    throw codedError('R6', 'Libellé « ' + labelKey + ' » absent de Config.LABELS');
  }
  return '<a href="' + escHtml(href) + '">' +
    '<span class="b-pager-kind">' + escHtml(label) + '</span>' +
    '<span class="b-pager-title">' + escHtml(title) + '</span>' +
    '</a>';
}

/**
 * Normalise un chemin d'article en chemin web absolu de la racine.
 * Accepte « blog/fr/x.html », « /blog/fr/x.html » et
 * « https://menuscan.space/blog/fr/x.html ».
 * Refuse toute origine étrangère (décision D9).
 *
 * @return {string} '' si le chemin est inexploitable
 */
function normalizeArticleHref(value) {
  var raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    var origin = assertSiteOrigin();
    if (raw.slice(0, origin.length + 1) !== origin + '/') return '';
    raw = raw.slice(origin.length);
  }

  raw = raw.replace(/^\/+/, '');
  var m = /^blog\/([a-z0-9-]+)\/([a-z0-9-]+)\.html$/.exec(raw);
  if (!m) return '';
  return '/' + raw;
}

/* -------------------------------------------------------------------------- */
/* Substitution des placeholders                                              */
/* -------------------------------------------------------------------------- */

/** Échappe une valeur selon le site : 'html' → escHtml, 'json' → escJson. */
function escapeForSite(value, mode) {
  if (mode === 'json') return escJson(value);
  if (mode === 'raw') return String(value === null || value === undefined ? '' : value);
  return escHtml(value);
}

/** Règle d'ancrage applicable à la position courante (ancre la plus longue). */
function matchSiteRule(token, before) {
  var rules = token === 'DESCRIPTION' ? DESCRIPTION_SITE_RULES : TITLE_SITE_RULES;
  var window = before.slice(-160);
  var best = null;
  rules.forEach(function (rule) {
    if (window.slice(-rule.anchor.length) === rule.anchor) {
      if (!best || rule.anchor.length > best.anchor.length) best = rule;
    }
  });
  return best;
}

/**
 * Bornes des commentaires HTML d'un fragment.
 * Le gabarit documente son usage avec un commentaire contenant
 * « {{PLACEHOLDER}} » : la substitution doit l'IGNORER, sinon le jeton de
 * documentation serait pris pour un champ à remplir. Le commentaire est
 * CONSERVÉ dans la page publiée : c'est lui qui documente le gabarit sur
 * GitHub.
 *
 * @return {Array<[number,number]>} couples [début, fin[
 */
function htmlCommentRanges(html) {
  var ranges = [];
  var re = /<!--[\s\S]*?-->/g;
  var m;
  while ((m = re.exec(String(html || ''))) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** true si `index` tombe à l'intérieur d'un commentaire HTML. */
function isInsideComment(ranges, index) {
  for (var i = 0; i < ranges.length; i++) {
    if (index >= ranges[i][0] && index < ranges[i][1]) return true;
  }
  return false;
}

/**
 * Substitution en UNE seule passe de gauche à droite.
 *
 * `{{TITLE}}` et `{{DESCRIPTION}}` sont multi-sens : ils sont résolus par
 * ancrage contextuel. Les 33 autres placeholders sont à valeur unique et
 * résolus par table. Les placeholders `RAW_HTML_PLACEHOLDERS` sont du HTML de
 * confiance : ils ne sont PAS échappés (PO : ne pas doubler l'échappement).
 *
 * Une substitution ne réexamine jamais le texte déjà produit : une valeur
 * contenant « {{…}} » ne peut donc pas provoquer de cascade.
 *
 * @param {string} template
 * @param {Object} table  {values, single, singleMode}
 * @return {{html:string, counts:Object}}
 * @throws {Error} sur placeholder inconnu, ancre non reconnue ou table incomplète
 */
function substitutePlaceholders(template, table) {
  var source = String(template || '');
  var comments = htmlCommentRanges(source);
  var re = /\{\{([A-Z_]+)\}\}/g;
  var out = '';
  var last = 0;
  var counts = {};
  var m;

  while ((m = re.exec(source)) !== null) {
    if (isInsideComment(comments, m.index)) continue;

    var token = m[1];
    out += source.slice(last, m.index);
    last = m.index + m[0].length;

    if (token === 'TITLE' || token === 'DESCRIPTION') {
      var rule = matchSiteRule(token, source.slice(0, m.index));
      if (!rule) {
        throw new Error(
          'Site non reconnu pour {{' + token + '}} : le gabarit a divergé. ' +
          'Contexte : « ' + source.slice(Math.max(0, m.index - 60), m.index).replace(/\s+/g, ' ') + ' »'
        );
      }
      counts[token] = (counts[token] || 0) + 1;
      out += escapeForSite(table.values[rule.slot], rule.mode);
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(table.single, token)) {
      throw new Error('Placeholder sans valeur : {{' + token + '}}');
    }
    counts[token] = (counts[token] || 0) + 1;
    out += escapeForSite(table.single[token], table.singleMode[token]);
  }

  out += source.slice(last);
  return { html: out, counts: counts };
}

/**
 * Résout le <title> en entier, suffixe de marque compris.
 *
 * Le gabarit ne porte QUE `{{TITLE}}` : le suffixe est INJECTÉ ici, il n'est
 * donc jamais dupliqué (withBrandSuffix absorbe un suffixe déjà présent dans
 * SEO_TITLE). og:title et twitter:title ne reçoivent RIEN : ils sont
 * résolus par la passe de substitution, comme les autres sites.
 *
 * Un gabarit dont le <title> a disparu (ou été dupliqué) est une ERREUR : le
 * titre est le champ SEO le plus visible de la page.
 *
 * @return {{html:string, sites:{title:number}}}
 */
function applySuffixedTitleSites(template, values) {
  var html = String(template || '');
  var sites = { title: 0 };

  html = html.replace(/(<title>)(\s*)\{\{TITLE\}\}(\s*)(<\/title>)/gi,
    function (whole, open, before, after, close) {
      sites.title += 1;
      return open + before + escHtml(withBrandSuffix(values.pageTitle)) + after + close;
    });

  if (sites.title !== 1) {
    throw codedError('R5b', 'Gabarit : <title> attendu une fois (trouvé ' + sites.title + ').');
  }
  return { html: html, sites: sites };
}

/* -------------------------------------------------------------------------- */
/* Post-traitement de production                                              */
/* -------------------------------------------------------------------------- */

/**
 * Règle 2 — profondeur des assets : « assets/… » → « ../assets/… ».
 *
 * Appliqué à la SORTIE uniquement : le gabarit écrit ses assets sans préfixe
 * (« assets/… »), le moteur ajoute le niveau qu'impose /blog/{lang}/.
 * Les chemins ABSOLUS du site (`/apple-touch-icon.png`, `https://fonts…`) et
 * les assets déjà préfixés ne sont jamais touchés : le motif refuse `..` en
 * tête et exige un `/` juste avant la racine.
 */
function deepenAssets(html) {
  var out = String(html || '');
  DEPTH_ONE_ASSET_ROOTS.forEach(function (root) {
    // L'ancre ne CONSOMME pas le séparateur : le préfixe est inséré devant la
    // racine et le « / » d'origine reste en place.
    var pattern = new RegExp('((?:href|src)=["\'])(?!\\.\\./)(?![a-z0-9+.-]*:)(?!/)(' +
      escapeRegExp(root) + ')(?=["\'/])', 'g');
    out = out.replace(pattern, '$1' + APP.ARTICLE_DEPTH_PREFIX + '$2');
  });
  return out;
}

/**
 * Règle 3 (bis) — image de couverture : le <img> garde le chemin racine, les
 * meta et le JSON-LD portent l'URL ABSOLUE.
 *
* og:image est ABSOLU : les réseaux sociaux ne résolvent pas un chemin
 * relatif, alors que le `<img>` de la page doit rester tel que saisi : c'est
 * le contrat de validateRenderedHtml (P6 à P6f).
 */
function absoluteImageMeta(html, imagePath) {
  var out = String(html || '');
  if (!imagePath) return out;
  var absolute = buildSiteUrl(imagePath);
  var rel = escHtml(imagePath);
  var abs = escHtml(absolute);

  out = out.replace('<meta property="og:image" content="' + rel + '">',
    '<meta property="og:image" content="' + abs + '">');
  out = out.replace('<meta name="twitter:image" content="' + rel + '">',
    '<meta name="twitter:image" content="' + abs + '">');
  out = out.replace('"image": ["' + rel + '"]', '"image": ["' + abs + '"]');

  return out;
}

/** Règle 3 — robots : « noindex, nofollow » → « index, follow » (occurrence unique). */
function publishRobots(html) {
  var out = String(html || '');
  var matches = out.match(new RegExp(escapeRegExp(TEMPLATE_ROBOTS), 'g')) || [];
  if (matches.length !== 1) {
    throw new Error(
      'Robots du gabarit : ' + matches.length + ' occurrence(s) de « ' +
      TEMPLATE_ROBOTS + ' » (attendu 1).'
    );
  }
  return out.split(TEMPLATE_ROBOTS).join(PUBLISHED_ROBOTS);
}

/* -------------------------------------------------------------------------- */
/* Rendu                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Emplacements SEO sans valeur tolérés : tout le reste part dans le HTML.
 * Avec les chaînes de repli actuelles, `missing` est « tout ou rien » : les
 * six emplacements obligatoires sont donc toujours remplis ensemble quand
 * `validateArticle` a accepté la ligne. Le contrôle reste car il protège les
 * emplacements futurs, dont la chaîne de repli serait vide.
 */
var REQUIRED_SEO_SLOTS = ['pageTitle', 'headline', 'metaDescription',
  'jsonLdHeadline', 'jsonLdDescription', 'breadcrumbTitle'];

/**
 * Libellés d'interface obligatoires dans une page publiée.
 *
 * Mêmes clés que le groupe « Pagination + pied de page » de
 * `REQUIRED_PLACEHOLDERS` : un article publié ne doit jamais laisser un libellé
 * vide, sinon le footer s'affiche avec un trou silencieux.
 */
var REQUIRED_LABELS = ['NAV_BLOG', 'NAV_ARIA', 'NAV_HOME_ARIA',
  'TRANSLATIONS_ARIA', 'TOC_HEADING', 'PAGER_ARIA', 'FOOTER_BLOG',
  'FOOTER_CONTACT', 'FOOTER_INSTAGRAM', 'FOOTER_COPYRIGHT', 'FOOTER_CREDIT'];

/**
 * Emplacements obligatoires vides dans un modèle déjà construit.
 * Fonction pure : testable directement, sans passer par le moteur.
 *
 * @param {{values:Object}} model
 * @return {string[]} noms des emplacements obligatoires sans valeur
 */
function requiredSlotsMissing(model) {
  var values = (model && model.values) || {};
  return REQUIRED_SEO_SLOTS.filter(function (slot) { return !values[slot]; });
}

/** true si la ligne est publiable (statut PUBLISHED ou non renseigné). */
function isPublishable(row) {
  if (!row) return false;
  return String(row.STATUS === null || row.STATUS === undefined || row.STATUS === ''
    ? 'PUBLISHED' : row.STATUS).trim().toUpperCase() === 'PUBLISHED';
}

/**
 * true si la ligne peut être RENDUE à cet instant.
 *
 * `isPublishable()` répond à « cette ligne fait-elle partie du jeu éditorial ? »
 * (voisines, `articles.json`) : seul PUBLISHED y compte, et c'est vrai.
 *
 * Le rendu, lui, est aussi appelé AU MILIEU du pipeline de publication, quand
 * le Publisher a déjà posé PUBLISHING pour verrouiller la ligne contre une
 * double publication. Refuser ce statut ferait échouer toute publication (R0) :
 * les deux règles doivent donc rester distinctes. READY, DRAFT, ERROR et
 * SUPPRIMÉ restent refusés — une ligne non publiée n'est jamais rendue.
 */
function isRenderableStatus(row) {
  if (!row) return false;
  var raw = row.STATUS === null || row.STATUS === undefined || row.STATUS === ''
    ? 'PUBLISHED' : row.STATUS;
  var status = String(raw).trim().toUpperCase();
  return status === 'PUBLISHED' || status === 'PUBLISHING';
}

/**
 * Lignes PUBLIÉES d'une langue, la ligne courante exclue, dans l'ORDRE DU
 * TABLEAU — c'est l'ordre éditorial saisi, donc le même dans l'aperçu et sur
 * le site. Aucune autre source d'ordre n'est introduite ici.
 *
 * @param {{lang:string, slug:string}} article
 * @param {Array<Object>} published
 * @return {Array<{title:string, path:string, row:Object}>}
 */
function publishedNeighbours(article, published) {
  var rows = Array.isArray(published) ? published : [];
  var lang = String(article.lang || '').trim();
  var slug = String(article.slug || '').trim();
  return rows.filter(function (row) {
    if (!isPublishable(row)) return false;
    if (String(row.LANG || '').trim() !== lang) return false;
    var rowSlug = String(row.SLUG || '').trim();
    return isValidSlug(rowSlug) && rowSlug !== slug;
  }).map(function (row) {
    return {
      title: String(row.TITLE || '').trim(),
      path: sitePath(row.LANG, row.SLUG),
      row: row
    };
  });
}

/**
 * Articles similaires : même langue et même catégorie, l'article courant
 * exclu. À défaut de voisin de catégorie (article seul dans sa catégorie), la
 * liste retombe sur les autres articles de la langue plutôt que d'être vide :
 * le bloc « Articles similaires » vaut mieux que son absence.
 */
function relatedFromPublished(article, published, limit) {
  var lang = String(article.lang || '').trim();
  var slug = String(article.slug || '').trim();
  var category;
  try {
    category = resolveCategory(article.CATEGORY, lang).slug;
  } catch (e) {
    category = '';
  }
  var neighbours = publishedNeighbours({ lang: lang, slug: slug }, published);
  var sameCategory = neighbours.filter(function (item) {
    try {
      return resolveCategory(item.row.CATEGORY, lang).slug === category;
    } catch (e) {
      return false;
    }
  });
  var pool = sameCategory.length ? sameCategory : neighbours;
  return pool.slice(0, limit || 4);
}

/**
 * Lignes PUBLIÉES retenues pour la page en cours : celles transmises par
 * l'appelant, moins tout doublon de l'article courant, plus l'article lui-même
 * une seule et même fois.
 *
 * `options.published` est documenté comme « les autres lignes PUBLIÉES », mais
 * l'appelant peut légitimement passer l'ensemble complet (c'est le cas d'un
 * aperçu de lot). Normaliser ici ferme les deux pièges symétriques : un faux
 * X1/X2 sur la copie de l'article, et un pager vide parce que l'article courant
 * manque et que `pagerNeighbours` ne le trouve pas.
 *
 * UNE seule occurrence de l'article courant est retirée : les autres restent, et
 * un doublon RÉEL (deux lignes pour la même URL) est toujours signalé par
 * `validateArticleSet`. Les brouillons sont écartés — une ligne non publiée ne
 * doit produire ni lien, ni ERROR.
 */
function renderableRows(article, published) {
  var lang = String(article.LANG || '').trim();
  var slug = String(article.SLUG || '').trim();
  var rows = (Array.isArray(published) ? published : []).filter(isPublishable);
  var copy = -1;
  rows.forEach(function (row, index) {
    if (copy === -1 &&
      String(row.LANG || '').trim() === lang &&
      String(row.SLUG || '').trim() === slug) {
      copy = index;
    }
  });
  if (copy !== -1) rows = rows.slice(0, copy).concat(rows.slice(copy + 1));
  return rows.concat([article]);
}

/**
 * Voisins de pagination : la ligne qui précède et celle qui suit, dans
 * l'ordre du tableau. `null` en bord de liste (le template les omet alors).
 */
function pagerNeighbours(article, published) {
  var rows = Array.isArray(published) ? published : [];
  var lang = String(article.lang || '').trim();
  var slug = String(article.slug || '').trim();

  var mine = -1;
  var usable = [];
  rows.forEach(function (row, index) {
    if (!isPublishable(row)) return;
    if (String(row.LANG || '').trim() !== lang) return;
    var rowSlug = String(row.SLUG || '').trim();
    if (!isValidSlug(rowSlug)) return;
    if (rowSlug === slug) { mine = index; return; }
    usable.push({
      index: index,
      title: String(row.TITLE || '').trim(),
      path: sitePath(row.LANG, row.SLUG)
    });
  });

  if (mine === -1) return { previous: null, next: null };

  var previous = null;
  var next = null;
  usable.forEach(function (item) {
    if (item.index < mine && (!previous || item.index > previous.index)) previous = item;
    if (item.index > mine && (!next || item.index < next.index)) next = item;
  });
  return { previous: previous, next: next };
}

/**
 * Rend l'HTML final d'un article. PUR : aucun effet de bord, aucun réseau,
 * aucune écriture. L'appelant ne publiera `result.html` que si `result.ok`.
 *
 * @param {Object} article  ligne `Articles`
 * @param {{templateHtml:string, published?:Array<Object>, faq?:*,
 *          related?:Array<Object>, previous?:Object, next?:Object,
 *          seo?:Object, readingTime?:*, publishedAt?:string,
 *          modifiedAt?:string, faqHeading?:string}} options
 * @return {{ok:boolean, html?:string, path?:string, sitePath?:string,
 *           canonicalUrl?:string, lang?:string, hreflang?:Object,
 *           validation?:Object, errors?:Object[], warnings?:Object[]}}
 */
function renderArticleHtml(article, options) {
  var opts = options || {};
  var errors = [];
  var warnings = [];

  /* --- 0. Préconditions -------------------------------------------------- */
  if (!article) {
    return fail('Article absent');
  }
  var template = String(opts.templateHtml || '');
  if (!template) {
    return fail('Gabarit absent : templateHtml requis');
  }
  var templateCheck = validateTemplate(template);
  if (!templateCheck.ok) {
    return {
      ok: false,
      errors: templateCheck.errors,
      warnings: (templateCheck.warnings || []).concat(warnings),
      validation: templateCheck
    };
  }

  var articleCheck = validateArticle(article);
  if (!articleCheck.ok) {
    return { ok: false, errors: articleCheck.errors, warnings: articleCheck.warnings || [] };
  }
  var category = articleCheck.category;
  var lang = articleCheck.lang;
  var group = articleCheck.group;
  var slug = String(article.SLUG || '').trim();
  var sitePathOfArticle = articleCheck.sitePath;
  warnings = warnings.concat(articleCheck.warnings || []);

// Garde-fou : le moteur ne rend JAMAIS une ligne qui n'est pas PUBLIÉE —
    // ni publiée, ni en cours de publication (voir isRenderableStatus()).
    if (!isRenderableStatus(article)) {
      return fail('STATUT « ' + article.STATUS + ' » : seul PUBLISHED est rendu' +
        ' (PUBLISHING uniquement le temps de sa publication)');
    }

  var published = renderableRows(article, opts.published);
  var setCheck = validateArticleSet(published);
  if (!setCheck.ok) {
    return { ok: false, errors: setCheck.errors, warnings: warnings };
  }

  /* --- 1. Modèle SEO à 10 champs ---------------------------------------- */
  var model = buildSeoModel(article, { seo: opts.seo });
  warnings = warnings.concat(model.warnings);
  if (model.missing.length) {
    errors.push({
      code: 'R2',
      message: 'Emplacements SEO sans valeur : ' + model.missing.join(', ')
    });
  }
  requiredSlotsMissing(model).forEach(function (slot) {
    errors.push({ code: 'R2b', message: 'Emplacement SEO obligatoire vide : ' + slot });
  });

  /* --- 2. Dates (temps de lecture : donnée éditoriale, jamais calculé) --- */
  var publishedIso = String(article.PUBLISHED_AT || opts.publishedAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedIso)) {
    errors.push({
      code: 'R3a',
      message: 'PUBLISHED_AT absent ou invalide : « ' + publishedIso + ' » (attendu YYYY-MM-DD)'
    });
    publishedIso = publishedIso || '1970-01-01';
  }
  var modifiedIso = String(article.MODIFIED_AT || opts.modifiedAt || publishedIso).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(modifiedIso)) modifiedIso = publishedIso;

  var reading = normalizeReadingTime(
    String(article.READING_TIME === undefined || article.READING_TIME === null || article.READING_TIME === ''
      ? opts.readingTime
      : article.READING_TIME) || ''
  );
  if (reading.error) errors.push({ code: 'R3b', message: reading.error });

  var formattedPublished = formatDate(publishedIso, lang);
  if (!formattedPublished) {
    errors.push({ code: 'R3c', message: 'Date de publication non formatable : ' + publishedIso });
  }

  /* --- 3. Canonical et image -------------------------------------------- */
  var canonicalPath = sitePathOfArticle;
  var canonicalUrl = buildSiteUrl(canonicalPath);
  var imagePath = String(article.IMAGE_URL || '').trim();

  /* --- 4. Contenu de confiance ------------------------------------------ */
  // Voisins toujours calculés sur l'IDENTITÉ (lang/slug normalisés), jamais sur
  // la ligne brute : les deux fonctions de voisinage lisent `article.lang` et
  // `article.slug`, qui n'existent pas sur une ligne `Articles` (LANG/SLUG).
  var neighbours = { lang: lang, slug: slug, CATEGORY: category.slug };
  var newline = detectNewline(template);
  var body = ensureHeadingIds(String(article.CONTENT || '')).body;
  var faqHtml = buildFaqSection(opts.faq, {
    heading: opts.faqHeading || getLabelRaw('FAQ_HEADING', lang),
    newline: newline
  });
  if (faqHtml && body.indexOf('id="faq"') !== -1) {
    errors.push({
      code: 'R4a',
      message: 'Le corps contient déjà id="faq" : le bloc FAQ entrerait en collision'
    });
  }
  if (containsScript(body)) {
    errors.push({ code: 'R4b', message: 'CONTENT : motif de script détecté (neutralisé)' });
  }

  var tocSource = body + (faqHtml ? newline + faqHtml : '');
  var tocItems = buildTocItems(tocSource, { newline: newline });
  // Le sommaire est construit à partir des TITRES : une FAQ rendue doit donc
  // y figurer. Le contrôle porte sur la sortie du sommaire, pas sur le corps.
  if (faqHtml && tocItems.indexOf('<li><a href="#faq">') === -1) {
    errors.push({ code: 'R4c', message: 'Le sommaire ne référence pas #faq' });
  }

  var relatedHtml = buildRelatedArticles(
    opts.related || relatedFromPublished(neighbours, published, 4), {
      heading: getLabelRaw('RELATED_HEADING', lang),
      newline: newline
    });

  var pager = (opts.previous || opts.next)
    ? { previous: opts.previous || null, next: opts.next || null }
    : pagerNeighbours(neighbours, published);
  var prevLink = buildArticleLink(pager.previous, 'previous', { lang: lang });
  var nextLink = buildArticleLink(pager.next, 'next', { lang: lang });

  /* --- 5. Traductions : hreflang + sélecteur de langue ------------------- */
  var identity = { lang: lang, slug: slug, group: group, sitePath: sitePathOfArticle };
  var hreflang = buildHreflangLinks(identity, published);
  var translationLinks = buildTranslationLinks(identity, published, { newline: newline });

  /* --- 6. Table de substitution ------------------------------------------ */
  var categoryLabel = getCategoryLabelRaw(category.slug, lang);
  var single = {
    LANG: lang,
    DIR: dirForLang(lang),
    CANONICAL_PATH: canonicalPath,
    OG_LOCALE: getOgLocale(lang),
    ARTICLE_IMAGE: imagePath,
    IMAGE_ALT: String(article.IMAGE_ALT || ''),
    IMAGE_WIDTH: String(article.IMAGE_WIDTH || ''),
    IMAGE_HEIGHT: String(article.IMAGE_HEIGHT || ''),
    DATE_PUBLISHED: publishedIso,
    DATE_MODIFIED: modifiedIso,
    CATEGORY: categoryLabel,
    CATEGORY_NAME: categoryLabel,
    CATEGORY_SLUG: category.slug,
    HREFLANG_LINKS: hreflang.html,
    TRANSLATION_LINKS: translationLinks,
    NAV_BLOG: getLabelRaw('NAV_BLOG', lang),
    NAV_ARIA: getLabelRaw('NAV_ARIA', lang),
    NAV_HOME_ARIA: getLabelRaw('NAV_HOME_ARIA', lang),
    TRANSLATIONS_ARIA: getLabelRaw('TRANSLATIONS_ARIA', lang),
    TOC_HEADING: getLabelRaw('TOC_HEADING', lang),
    TOC_ITEMS: tocItems,
    DATE_PUBLISHED_FORMATTED: formattedPublished,
    READING_TIME: reading.value,
    ARTICLE_BODY: body,
    FAQ_SECTION: faqHtml,
    CTA_BLOCK: buildCtaBlock(lang),
    RELATED_ARTICLES: relatedHtml,
    PAGER_ARIA: getLabelRaw('PAGER_ARIA', lang),
    PREV_LINK: prevLink,
    NEXT_LINK: nextLink,
    FOOTER_BLOG: getLabelRaw('FOOTER_BLOG', lang),
    FOOTER_CONTACT: getLabelRaw('FOOTER_CONTACT', lang),
    FOOTER_INSTAGRAM: getLabelRaw('FOOTER_INSTAGRAM', lang),
    FOOTER_COPYRIGHT: getLabelRaw('FOOTER_COPYRIGHT', lang),
    FOOTER_CREDIT: getLabelRaw('FOOTER_CREDIT', lang)
  };
  var singleMode = {};
  RAW_HTML_PLACEHOLDERS.forEach(function (p) { singleMode[p] = 'raw'; });

  // Un libellé manquant produirait un attribut vide (« aria-label="" ») : la
  // page perdrait son accessibilité sans qu'aucune erreur ne le signale.
  var missingLabels = REQUIRED_LABELS.filter(function (key) { return !single[key]; });
  if (missingLabels.length) {
    errors.push({
      code: 'R6b',
      message: 'Libellés absents de Config.LABELS pour « ' + lang + ' » : ' + missingLabels.join(', ')
    });
  }

  /* --- 7. Substitution puis post-traitement ----------------------------- */
  var html;
  try {
    var suffixed = applySuffixedTitleSites(template, model.values);
    var substituted = substitutePlaceholders(suffixed.html, {
      values: model.values, single: single, singleMode: singleMode
    });
    html = substituted.html;
  } catch (e) {
    // Une violation de contrat du GABARIT porte déjà son code (R5b) :
    // elle ne doit pas être diluée dans le R5 générique de substitution.
    return {
      ok: false,
      errors: [{ code: e.code || 'R5', message: e.message }],
      warnings: warnings
    };
  }

  try {
    html = deepenAssets(html);                  // règle 2
    html = publishRobots(html);                 // règle 3
    html = absoluteImageMeta(html, imagePath);  // règle 3 bis
  } catch (e) {
    return { ok: false, errors: [{ code: e.code || 'R5b', message: e.message }], warnings: warnings };
  }

  /* --- 8. Contrat de production, AVANT toute écriture -------------------- */
  var validation = validateRenderedHtml(html, {
    canonicalPath: canonicalPath,
    lang: lang,
    dir: dirForLang(lang),
    ogLocale: getOgLocale(lang),
    imagePath: imagePath,
    imageWidth: article.IMAGE_WIDTH,
    imageHeight: article.IMAGE_HEIGHT,
    publishedIso: publishedIso,
    modifiedIso: modifiedIso,
    readingTime: reading.value,
    categorySlug: category.slug,
    categoryLabel: escHtml(categoryLabel),
    hreflang: hreflang.links
  });
  if (errors.length) {
    return { ok: false, errors: errors, warnings: warnings, validation: validation };
  }
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: warnings, validation: validation };
  }
  warnings = warnings.concat(validation.warnings || []);

  return {
    ok: true,
    html: html,
    path: articleCheck.path,
    sitePath: sitePathOfArticle,
    canonicalUrl: canonicalUrl,
    lang: lang,
    group: group,
    category: category,
    hreflang: hreflang.links,
    model: model,
    validation: validation,
    warnings: warnings,
    errors: []
  };

  function fail(message) {
    return { ok: false, errors: [{ code: 'R0', message: message }], warnings: [] };
  }
}
