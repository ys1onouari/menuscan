/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Validator.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : moteur de validation. Aucune écriture, aucun effet de
 * bord hormis la lecture de Config (pour la table de catégories, D2).
 *
 * Trois familles :
 *   validateArticle(a)      → champs de la ligne Sheets        (V1-V7, V12)
 *   validateRenderedHtml()  → HTML rendu                        (V9-V11 + production)
 *   validateTemplate()      → gabarit chargé depuis GitHub      (pré-requis)
 *
 * V8 (cible absente de GitHub) est un contrôle réseau : voir checkTargetPath.
 */

/**
 * Placeholders attendus du gabarit : les 35 emplacements réels de
 * `public/blog/template-article.html`. La liste est le contrat de rendu — un
 * gabarit qui perd un emplacement est refusé, pas complété par un repli muet.
 */
var REQUIRED_PLACEHOLDERS = [
  // Document + SEO
  'LANG', 'DIR', 'TITLE', 'DESCRIPTION', 'CANONICAL_PATH', 'OG_LOCALE',
  'ARTICLE_IMAGE', 'IMAGE_ALT', 'IMAGE_WIDTH', 'IMAGE_HEIGHT',
  'DATE_PUBLISHED', 'DATE_MODIFIED', 'CATEGORY', 'CATEGORY_NAME',
  'CATEGORY_SLUG', 'HREFLANG_LINKS',
  // Navigation
  'NAV_BLOG', 'NAV_ARIA', 'NAV_HOME_ARIA', 'TRANSLATIONS_ARIA',
  'TRANSLATION_LINKS',
  // Corps
  'TOC_HEADING', 'TOC_ITEMS', 'DATE_PUBLISHED_FORMATTED', 'READING_TIME',
  'ARTICLE_BODY', 'FAQ_SECTION', 'CTA_BLOCK', 'RELATED_ARTICLES',
  // Pagination + pied de page
  'PAGER_ARIA', 'PREV_LINK', 'NEXT_LINK',
  'FOOTER_ARIA', 'FOOTER_HOME', 'FOOTER_CONTACT'
];

/**
 * Occurrences attendues des deux placeholders multi-sens.
 * `{{TITLE}}` porte 6 sens distincts (7 sites), `{{DESCRIPTION}}` 5 : un compte
 * différent signale un gabarit qui a divergé, pas une donnée manquante.
 */
var PLACEHOLDER_COUNTS = { TITLE: 7, DESCRIPTION: 5 };

/** Extensions d'image locale admises (FEATURED_IMAGE dans Config). */
var IMAGE_EXTENSIONS = ['webp', 'jpg', 'jpeg', 'png', 'avif'];

/** Gabarit : la profondeur de ses assets vaut 1 niveau (il est à la racine de blog/). */
var TEMPLATE_ROBOTS = 'noindex, nofollow';
/** Production : métadonnées indexables. */
var PUBLISHED_ROBOTS = 'index, follow';

/* -------------------------------------------------------------------------- */
/* HTML saisi (CONTENT)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Balises admises dans CONTENT.
 *
 * Liste fermée, établie par l'union de deux sources de vérité :
 *   1. le corps de l'article de RÉFÉRENCE publié
 *      (public/blog/fr/menu-digital-qr-code-restaurant-maroc.html) :
 *      blockquote, div, h2, h3, li, p, strong, ul ;
 *   2. les fixtures de contenu des testslegacy (apps-script/tests/*.cjs) :
 *      a, em, img, ol, table, tbody, td, th, thead, tr, details, summary.
 *
 * `h2`/`h3` sont les seuls titres : le sommaire (`buildTocItems`) ne retient que
 * eux, un `h4` produirait un titre sans entrée de sommaire. Aucune balise de
 * structure supplémentaire (figure, caption, colgroup) n'est utilisée par ces
 * deux sources : elle est refusée, et le message d'erreur donne la liste.
 */
var CONTENT_ALLOWED_TAGS = [
  'a', 'blockquote', 'details', 'div', 'em', 'h2', 'h3', 'img', 'li', 'ol',
  'p', 'strong', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
];

/**
 * Balises INTERDITES, nommées explicitement pour produire un message qui désigne
 * la cause au lieu d'un « tag inconnu » générique. Elles sont toutes hors liste
 * fermée : V21 est un diagnostic, V20 reste le filet de sécurité.
 */
var CONTENT_FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link',
  'style', 'svg', 'math', 'input', 'button', 'textarea', 'select', 'frame',
  'frameset', 'applet', 'template', 'slot'
];

/** Attributs porteurs d'une URL : le contrôle « http:// » les regarde, rien d'autre. */
var CONTENT_URL_ATTRS = ['href', 'src', 'action', 'data', 'formaction', 'poster', 'srcset'];

/**
 * Contrôles du HTML SAISI (CONTENT), complements de V5 (présence + équilibre).
 *
 * Le corps de l'article est inséré TEL QUEL dans la page : c'est la seule zone
 * du rendu qui échappe à `escHtml`. Ces contrôles sont donc la barrière de
 * sécurité principale — le contrôle P4 du HTML rendu n'est qu'une défense en
 * profondeur (il ne voit, lui, que le document final).
 *
 * Codes : V20 tag hors liste, V21 balise dangereuse, V22 attribut d'événement,
 *         V23 pseudo-URL, V24 style dangereux, V25 URL en http://.
 *
 * @param {string} content
 * @return {Array<{code:string, message:string}>} erreurs, dans l'ordre du HTML
 */
function validateContentHtml(content) {
  var errors = [];
  var html = String(content === null || content === undefined ? '' : content);
  if (!html) return errors;

  var tags = html.match(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g) || [];
  var seen = {};

  tags.forEach(function (rawTag) {
    var m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>$/.exec(rawTag);
    if (!m) return;
    var name = m[2].toLowerCase();
    var attrs = m[3] || '';

    /* --- V21 : balise dangereuse, nommée --------------------------------- */
    if (CONTENT_FORBIDDEN_TAGS.indexOf(name) !== -1) {
      var key21 = 'V21:' + name;
      if (!seen[key21]) {
        seen[key21] = true;
        var detail = name;
        if (name === 'meta' && /http-equiv\s*=\s*["']?refresh/i.test(attrs)) {
          detail = 'meta http-equiv="refresh"';
        }
        errors.push({
          code: 'V21',
          message: 'CONTENT : balise <' + detail + '> interdite dans le corps de l\'article'
        });
      }
    }

    /* --- V20 : balise hors liste fermée ---------------------------------- */
    if (CONTENT_ALLOWED_TAGS.indexOf(name) === -1 &&
      CONTENT_FORBIDDEN_TAGS.indexOf(name) === -1) {
      var key20 = 'V20:' + name;
      if (!seen[key20]) {
        seen[key20] = true;
        errors.push({
          code: 'V20',
          message: 'CONTENT : balise <' + name + '> non autorisée ' +
            '(autorisées : ' + CONTENT_ALLOWED_TAGS.join(', ') + ')'
        });
      }
    }

    /* --- V22 : attribut d'événement inline ------------------------------ */
    var handler = attrs.match(/\s(on[a-zA-Z]+)\s*=/);
    if (handler) {
      var key22 = 'V22:' + handler[1].toLowerCase();
      if (!seen[key22]) {
        seen[key22] = true;
        errors.push({
          code: 'V22',
          message: 'CONTENT : attribut d\'événement ' + handler[1].toLowerCase() +
            '=' + ' interdit dans le corps'
        });
      }
    }

    /* --- V23 : pseudo-URL dans un attribut ------------------------------ */
    var pseudo = attrs.match(/(javascript|vbscript|data)\s*:/i);
    if (pseudo && !/^data:image\//i.test(attrs)) {
      errors.push({
        code: 'V23',
        message: 'CONTENT : pseudo-URL « ' + pseudo[1].toLowerCase() +
          ': » interdite dans un attribut du corps'
      });
    }

    /* --- V24 : style dangereux ------------------------------------------ */
    var style = /style\s*=\s*"([^"]*)"/i.exec(attrs) || /style\s*=\s*'([^']*)'/i.exec(attrs);
    if (style && /(expression\s*\(|url\s*\(\s*["']?\s*(javascript|vbscript|data)\s*:|behaviou?r\s*:|-moz-binding)/i
      .test(style[1])) {
      errors.push({
        code: 'V24',
        message: 'CONTENT : style dangereux dans un attribut style= : ' +
          style[1].slice(0, 80)
      });
    }

    /* --- V25 : URL non sécurisée ---------------------------------------- */
    CONTENT_URL_ATTRS.forEach(function (attr) {
      var re = new RegExp('\\b' + attr + '\\s*=\\s*"([^"]*)"', 'i');
      var re2 = new RegExp("\\b" + attr + "\\s*=\\s*'([^']*)'", 'i');
      var url = (re.exec(attrs) || re2.exec(attrs) || [])[1];
      if (url && /^\s*http:\/\//i.test(url)) {
        errors.push({
          code: 'V25',
          message: 'CONTENT : URL en http:// dans ' + attr + '= : « ' +
            url.slice(0, 80) + ' » (https:// ou chemin relatif attendu)'
        });
      }
    });
  });

  /* --- V24bis : <style> ou url(javascript:) hors attribut ------------------ */
  if (/<style\b/i.test(html)) {
    errors.push({ code: 'V24', message: 'CONTENT : <style> est interdit dans le corps' });
  }

  return errors;
}

/* -------------------------------------------------------------------------- */
/* Lignes Articles                                                            */
/* -------------------------------------------------------------------------- */

function validateArticle(article) {
  var errors = [];
  var warnings = [];

  if (!article) return { ok: false, errors: [{ code: 'V0', message: 'Article absent' }], warnings: [] };

  // V1 — TITLE
  if (!article.TITLE) {
    errors.push({ code: 'V1', message: 'TITLE est obligatoire' });
  }

  // V2 — SLUG
  if (!article.SLUG) {
    errors.push({ code: 'V2', message: 'SLUG est obligatoire' });
  } else if (!isValidSlug(article.SLUG)) {
    errors.push({
      code: 'V2',
      message: 'SLUG invalide (attendu minuscules, chiffres et tirets) : ' + article.SLUG
    });
  }

  // V14 — LANG : elle entre dans le chemin ET dans hreflang, donc obligatoire.
  var lang = String(article.LANG === null || article.LANG === undefined ? '' : article.LANG).trim();
  if (!lang) {
    errors.push({ code: 'V14', message: 'LANG est obligatoire (fr, en, es ou ar)' });
  } else if (!isSupportedLang(lang)) {
    errors.push({
      code: 'V14',
      message: 'LANG inconnue : « ' + lang + ' » (attendu ' + APP.SUPPORTED_LANGS.join(', ') + ')'
    });
  }

  // V15 — TRANSLATION_GROUP : facultatif, valeur par défaut = SLUG.
  var group = String(article.TRANSLATION_GROUP === null || article.TRANSLATION_GROUP === undefined
    ? '' : article.TRANSLATION_GROUP).trim();
  if (group && !/^[a-z0-9-]{1,80}$/.test(group)) {
    errors.push({
      code: 'V15',
      message: 'TRANSLATION_GROUP invalide (minuscules, chiffres et tirets, 80 max) : ' + group
    });
  }
  if (!group) group = String(article.SLUG || '').trim();

  // V3 — CATEGORY via table explicite (D2) ; jamais de création automatique.
  // Le libellé est résolu DANS la langue de l'article.
  var category = null;
  if (!article.CATEGORY) {
    errors.push({ code: 'V3', message: 'CATEGORY est obligatoire' });
  } else if (isSupportedLang(lang)) {
    try {
      category = resolveCategory(article.CATEGORY, lang);
    } catch (e) {
      errors.push({ code: 'V3', message: e.message });
    }
  }

  // V4 — META_DESCRIPTION (≤160, aligné sur le test SEO existant)
  if (!article.META_DESCRIPTION) {
    errors.push({ code: 'V4', message: 'META_DESCRIPTION est obligatoire' });
  } else if (article.META_DESCRIPTION.length > APP.MAX_DESCRIPTION) {
    errors.push({
      code: 'V4',
      message: 'META_DESCRIPTION trop long (' + article.META_DESCRIPTION.length +
        ' > ' + APP.MAX_DESCRIPTION + ')'
    });
  }

  // V5 — CONTENT
  if (!article.CONTENT) {
    errors.push({ code: 'V5', message: 'CONTENT est obligatoire' });
  } else {
    if (!isBalancedHtml(article.CONTENT)) {
      errors.push({ code: 'V5', message: 'CONTENT : balises HTML non équilibrées' });
    }
    // V20-V25 — le corps est inséré TEL QUEL (seule zone non échappée) : liste
    // fermée de balises, balises dangereuses, gestionnaires inline, pseudo-URL,
    // style dangereux, URL en http://.
    //
    // Ces contrôles tournent MÊME quand V5 a déjà tranché : `<script>` ou
    // `<embed>` sont à la fois déséquilibrés et interdits, et le message qui
    // nomme la cause est celui qu'il faut lire.
    validateContentHtml(article.CONTENT).forEach(function (err) {
      errors.push(err);
    });
  }

  // V6 — SEO_TITLE (avertissement, pas blocage)
  if (article.SEO_TITLE && (article.SEO_TITLE + BRAND_SUFFIX).length > 65) {
    warnings.push({
      code: 'V6',
      message: 'SEO_TITLE + suffixe > 65 caractères (risque de troncature SERP)'
    });
  }

  // V16 à V18 — image de couverture : locale sous /blog/images/ ou HTTPS listé.
  var hasImage = getConfigBoolean('ENABLE_FEATURED_IMAGE');
  var imagePath = String(article.IMAGE_URL === null || article.IMAGE_URL === undefined ? '' : article.IMAGE_URL).trim();
  if (!imagePath) {
    if (hasImage) errors.push({ code: 'V16', message: 'IMAGE_URL est obligatoire' });
  } else {
    var imageError = validateFeaturedImageUrl(imagePath);
    if (imageError) errors.push({ code: 'V16', message: imageError });
  }

  if (imagePath) {
    if (!String(article.IMAGE_ALT || '').trim()) {
      errors.push({
        code: 'V17',
        message: 'IMAGE_ALT est obligatoire (accessibilité + og:image:alt)'
      });
    }
    [['IMAGE_WIDTH', article.IMAGE_WIDTH], ['IMAGE_HEIGHT', article.IMAGE_HEIGHT]]
      .forEach(function (pair) {
        var raw = String(pair[1] === null || pair[1] === undefined ? '' : pair[1]).trim();
        if (!/^\d+$/.test(raw) || Number(raw) < 1) {
          errors.push({
            code: 'V18',
            message: pair[0] + ' doit être un entier positif : « ' + raw + ' »'
          });
        }
      });
  }

  // V19 — temps de lecture : saisi, jamais calculé.
  var readingRaw = String(article.READING_TIME === null || article.READING_TIME === undefined
    ? '' : article.READING_TIME).trim();
  if (!readingRaw) {
    errors.push({
      code: 'V19',
      message: 'READING_TIME est obligatoire : le moteur ne calcule jamais la durée'
    });
  } else if (!/^\d+$/.test(readingRaw) || Number(readingRaw) < 1 || Number(readingRaw) > 999) {
    errors.push({
      code: 'V19',
      message: 'READING_TIME doit être un entier entre 1 et 999 : « ' + readingRaw + ' »'
    });
  }

  // Décision D1 — champs de description distincts, contrôlés séparément
  ['SOCIAL_DESCRIPTION', 'ARTICLE_EXCERPT', 'CARD_EXCERPT'].forEach(function (field) {
    if (article[field] && article[field].length > APP.MAX_DESCRIPTION) {
      warnings.push({
        code: 'V1x',
        message: field + ' > ' + APP.MAX_DESCRIPTION + ' caractères'
      });
    }
  });

  // STATUS
  if (article.STATUS && VALID_STATUSES.indexOf(article.STATUS) === -1) {
    errors.push({
      code: 'V1y',
      message: 'STATUT inconnu : ' + article.STATUS +
        ' (attendu ' + VALID_STATUSES.join(', ') + ')'
    });
  }

  // V12 — motifs de script dans les champs textuels
  ['TITLE', 'SEO_TITLE', 'META_DESCRIPTION', 'SOCIAL_DESCRIPTION',
    'ARTICLE_EXCERPT', 'CARD_EXCERPT', 'KEYWORD', 'IMAGE_ALT',
    'IMAGE_CREDIT', 'TRANSLATION_GROUP'].forEach(function (field) {
      if (containsScript(article[field])) {
        errors.push({ code: 'V12', message: 'Contenu de script détecté dans ' + field });
      }
    });

  var result = { ok: errors.length === 0, errors: errors, warnings: warnings };
  if (isSupportedLang(lang)) {
    result.lang = lang;
    result.dir = dirForLang(lang);
    result.group = group;
  }
  if (category) {
    result.category = category;
    result.path = blogPath(lang, article.SLUG);
    result.sitePath = sitePath(lang, article.SLUG);
  }
  return result;
}

/**
 * Contrôles INTER-lignes sur l'ensemble des lignes à publier.
 *
 * Deux règles, toutes deux structurelles (elles décident de l'URL finale) :
 *   X1 — une seule ligne par (LANG, SLUG) : deux lignes produiraient le même
 *        chemin GitHub et la même URL ;
 *   X2 — une seule langue par TRANSLATION_GROUP : deux traductions de même
 *        langue dans un groupe ne peuvent pas se distinguer.
 *
 * @param {Array<Object>} rows
 * @return {{ok:boolean, errors:Object[], warnings:Object[]}}
 */
function validateArticleSet(rows) {
  var errors = [];
  var list = Array.isArray(rows) ? rows : [];
  var byPath = {};
  var byGroupLang = {};

  list.forEach(function (row, index) {
    if (!row) return;
    var lang = String(row.LANG || '').trim();
    var slug = String(row.SLUG || '').trim();
    var group = String(row.TRANSLATION_GROUP || '').trim() || slug;
    var label = 'ligne ' + (index + 2);

    if (lang && slug && isSupportedLang(lang) && isValidSlug(slug)) {
      var key = lang + '/' + slug;
      if (byPath[key]) {
        errors.push({
          code: 'X1',
          message: 'Deux lignes pour ' + key + ' (' + byPath[key] + ' et ' + label + ') : une seule URL par langue'
        });
      } else {
        byPath[key] = label;
      }
    }

    if (group && lang && isSupportedLang(lang)) {
      var gkey = group + '|' + lang;
      if (byGroupLang[gkey]) {
        errors.push({
          code: 'X2',
          message: 'TRANSLATION_GROUP « ' + group + ' » présent deux fois en ' + lang +
            ' (' + byGroupLang[gkey] + ' et ' + label + ')'
        });
      } else {
        byGroupLang[gkey] = label;
      }
    }
  });

  return { ok: errors.length === 0, errors: errors, warnings: [] };
}

/**
 * Valide une image de couverture. '' si l'URL est exploitable, sinon le motif
 * du refus.
 *
 * Deux formes admises, jamais mélangées :
 *   - locale  : /blog/images/<fichier>.(webp|jpg|jpeg|png|avif)
 *   - distante : https://<hôte de IMAGE_ALLOWED_HOSTS>/…
 * Le reste est refusé : `http:` (mixed content), `//` (hôte non vérifié),
 * `data:` et `javascript:`, et toute traversée `..`.
 */
function validateFeaturedImageUrl(url) {
  var s = String(url || '').trim();
  if (!s) return 'IMAGE_URL vide';
  if (/\s/.test(s)) return 'IMAGE_URL contient des espaces : ' + s;
  if (/[\u0000-\u001f]/.test(s)) return 'IMAGE_URL contient un caractère de contrôle';
  if (s.indexOf('..') !== -1) return 'IMAGE_URL ne doit pas contenir « .. » : ' + s;
  if (/^(javascript|data|vbscript|blob|file):/i.test(s)) {
    return 'IMAGE_URL refuse le protocole « ' + s.split(':')[0] + ' » : ' + s;
  }

  if (/^https:\/\//i.test(s)) {
    var host = hostOf(s);
    if (!host) return 'IMAGE_URL HTTPS sans hôte exploitable : ' + s;
    var allowed = getImageAllowedHosts();
    if (allowed.indexOf(host) === -1) {
      return 'IMAGE_URL : hôte « ' + host + ' » hors IMAGE_ALLOWED_HOSTS (' +
        (allowed.length ? allowed.join(', ') : 'liste vide') + ')';
    }
    if (!new RegExp('\\.(' + IMAGE_EXTENSIONS.join('|') + ')$', 'i').test(s.split('?')[0].split('#')[0])) {
      return 'IMAGE_URL distante : extension non admise (' + IMAGE_EXTENSIONS.join(', ') + ') : ' + s;
    }
    return '';
  }

  if (/^http:\/\//i.test(s)) return 'IMAGE_URL en http: refusé (contenu mixte) : ' + s;
  if (s.indexOf('//') === 0) return 'IMAGE_URL « //hôte/… » refusé (hôte non vérifiable) : ' + s;
  if (s.charAt(0) !== '/') return 'IMAGE_URL doit être un chemin absolu (/blog/images/…) : ' + s;

  var m = /^\/blog\/images\/([A-Za-z0-9._-]+)$/.exec(s);
  if (!m) return 'IMAGE_URL locale hors /blog/images/ : ' + s;
  var name = m[1];
  var ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTENSIONS.indexOf(ext) === -1) {
    return 'IMAGE_URL locale : extension non admise (' + IMAGE_EXTENSIONS.join(', ') + ') : ' + s;
  }
  return '';
}

/** V8 — la cible n'existe pas déjà sur GitHub. Contrôle réseau, en lecture. */
function checkTargetPath(article) {
  var v = validateArticle(article);
  if (!v.path) return { ok: false, reason: 'Chemin indéterminable (langue ou slug)' };
  if (fileExists(v.path)) {
    return { ok: false, reason: 'TARGET_ALREADY_EXISTS', path: v.path };
  }
  return { ok: true, path: v.path };
}

/* -------------------------------------------------------------------------- */
/* Gabarit                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Contrôle le gabarit AVANT tout rendu.
 *
 * Le gabarit doit conserver `noindex, nofollow` : c'est le MOTEUR qui bascule
 * en `index, follow` sur la sortie. Le gabarit n'est jamais modifié, et il
 * n'est jamais rendu tel quel : le nombre d'occurrences de chaque placeholder
 * fait partie du contrat.
 */
function validateTemplate(html) {
  var errors = [];
  var warnings = [];

  if (!html) {
    return { ok: false, errors: [{ code: 'T0', message: 'Gabarit vide' }], warnings: [] };
  }
  if (html.length > APP.MAX_TEMPLATE_BYTES) {
    errors.push({
      code: 'T1',
      message: 'Gabarit trop volumineux (' + html.length + ' > ' + APP.MAX_TEMPLATE_BYTES + ')'
    });
  }

  var missing = REQUIRED_PLACEHOLDERS.filter(function (p) {
    return html.indexOf('{{' + p + '}}') === -1;
  });
  if (missing.length) {
    errors.push({
      code: 'T2',
      message: 'Placeholders absents du gabarit : ' + missing.join(', ')
    });
  }

  // Un placeholder INCONNU est une erreur : il resterait littéral dans la sortie.
  var found = (html.match(/\{\{([A-Z_]+)\}\}/g) || []).map(function (token) {
    return token.slice(2, -2);
  });
  var unknown = unique(found).filter(function (token) {
    return REQUIRED_PLACEHOLDERS.indexOf(token) === -1;
  });
  if (unknown.length) {
    errors.push({
      code: 'T2b',
      message: 'Placeholders hors contrat dans le gabarit : ' + unknown.join(', ')
    });
  }

  // Comptes des deux placeholders multi-sens (résolus par ancrage contextuel).
  Object.keys(PLACEHOLDER_COUNTS).forEach(function (token) {
    var seen = found.filter(function (t) { return t === token; }).length;
    if (seen !== PLACEHOLDER_COUNTS[token]) {
      errors.push({
        code: 'T2c',
        message: '{{' + token + '}} : ' + seen + ' occurrence(s) dans le gabarit ' +
          '(attendu ' + PLACEHOLDER_COUNTS[token] + ')'
      });
    }
  });

  // Le basculement robots exige une occurrence UNIQUE, sinon il est ambigu.
  var robots = html.split('content="' + TEMPLATE_ROBOTS + '"').length - 1;
  if (robots !== 1) {
    errors.push({
      code: 'T3',
      message: 'Le gabarit doit porter « content="' + TEMPLATE_ROBOTS + '" » ' +
        'une fois exactement (trouvée : ' + robots + ')'
    });
  }

  // Le conteneur du sommaire est apparié par regex : il ne doit pas muter.
  if (!/<nav class="toc"[^>]*>\s*<ol>\s*\{\{TOC_ITEMS\}\}\s*<\/ol>\s*<\/nav>/i.test(html)) {
    errors.push({
      code: 'T6',
      message: 'Conteneur du sommaire attendu : <nav class="toc"><ol>{{TOC_ITEMS}}</ol></nav>'
    });
  }

  // Les assets sont écrits SANS « ../ » : le moteur ajoute le préfixe de
  // profondeur à la sortie. Un préfixe déjà présent trahirait une double
  // réécriture.
  if (/["'](?:\.\.\/)+(?:assets|css|js|icons|fonts)\//i.test(html)) {
    errors.push({
      code: 'T7',
      message: 'Le gabarit ne doit porter aucun préfixe de profondeur sur ses assets ' +
        '(« assets/… » sans « ../ »)'
    });
  }
  if (!/(?:href|src)=["']assets\//i.test(html)) {
    warnings.push({
      code: 'T8',
      message: 'Gabarit sans asset « assets/… » : la règle de profondeur n\'aurait rien à réécrire'
    });
  }

  if (containsScript(html.replace(/<script[\s\S]*?<\/script>/gi, ''))) {
    warnings.push({ code: 'T5', message: 'Balise ou attribut suspect hors <script>' });
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

/* -------------------------------------------------------------------------- */
/* HTML rendu                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Retire du rendu LA balise `<link>` de préchargement Google Fonts du GABARIT,
 * et elle seule.
 *
 * L'idiome est reconnu par ses QUATRE conditions réunies — `rel="preload"`,
 * `as="style"`, `href` vers `fonts.googleapis.com/css2?family=…`, et
 * `onload="this.onload=null;this.rel='stylesheet'"`. C'est la forme du gabarit
 * (template-article.html, ligne 58), présente dans tous les articles publiés.
 *
 * Toute autre balise reste dans le contrôle P4 : une `<link>` vers le même
 * hôte mais avec un autre `onload`, ou un `<img onerror=…>` glissé dans le
 * corps de l'article, sont donc refusés. Se contenter de « tout ce qui pointe
 * sur fonts.googleapis.com » laisserait passer un `onload` injecté par
 * l'éditeur.
 */
function stripGoogleFontLinks(html) {
  return String(html || '').replace(/<link\b[^>]*>/gi, function (tag) {
    var isPreload = /\brel\s*=\s*["']?preload["']?/i.test(tag);
    var isStyle = /\bas\s*=\s*["']?style["']?/i.test(tag);
    var isCss2 = /href\s*=\s*["']https:\/\/fonts\.googleapis\.com\/css2\?family=[^"']*["']/i.test(tag);
    var isSwap = /onload\s*=\s*["']this\.onload=null;this\.rel='stylesheet'["']/i.test(tag);
    return (isPreload && isStyle && isCss2 && isSwap) ? '' : tag;
  });
}

/**
 * Contrôle du HTML généré, juste avant publication.
 * Couvre V9 (ancres), V10 (placeholders résiduels), V11 (canonical) et les
 * invariants de production (profondeur, robots, langue, image, dates,
 * catégorie, hreflang, sélecteur de langue, `<h1>`).
 *
 * @param {string} html
 * @param {{canonicalPath:string, lang?:string, dir?:string, ogLocale?:string,
 *          imagePath?:string, imageWidth?:number, imageHeight?:number,
 *          publishedIso?:string, modifiedIso?:string, readingTime?:number,
 *          categorySlug?:string, categoryLabel?:string,
 *          hreflang?:Object<string,string>}} expected
 */
function validateRenderedHtml(html, expected) {
  var errors = [];
  var warnings = [];
  var text = String(html || '');
  var withoutComments = stripHtmlComments(text);

  // V10 — aucun placeholder résiduel (les commentaires HTML sont ignorés :
  // le gabarit contient un commentaire de développement).
  // Le motif accepte les placeholders à casse mixte (le contrôle historique ne
  // voyait que [A-Z_]) : une divergence de casse doit être signalée, pas ignorée.
  var residual = withoutComments.match(/\{\{[A-Za-z0-9_]+\}\}/g);
  if (residual) {
    errors.push({
      code: 'V10',
      message: 'Placeholders non substitués : ' + unique(residual).join(', ')
    });
  }

  // V11 — canonical exact
  if (expected && expected.canonicalPath) {
    var canonical = getMetaContent(text, 'canonical');
    // Un canonical ABSENT est une erreur : le contrôle historique ne comparait
    // que si la balise existait, laissant passer une sortie sans canonical.
    if (!canonical) {
      errors.push({
        code: 'V11a',
        message: 'Canonical absent (attendu ' + buildSiteUrl(expected.canonicalPath) + ')'
      });
    } else if (canonical !== buildSiteUrl(expected.canonicalPath)) {
      errors.push({
        code: 'V11',
        message: 'Canonical inattendu : ' + canonical +
          ' (attendu ' + buildSiteUrl(expected.canonicalPath) + ')'
      });
    }

    // Cohérence og:url et hreflang avec le canonical (invariant de production).
    ['og:url'].forEach(function (key) {
      var value = getMetaContent(text, key);
      if (value && value !== buildSiteUrl(expected.canonicalPath)) {
        errors.push({
          code: 'V11b',
          message: key + ' incohérent : ' + value +
            ' (attendu ' + buildSiteUrl(expected.canonicalPath) + ')'
        });
      }
    });
  }

  // Production — robots indexable
  if (text.indexOf('content="' + PUBLISHED_ROBOTS + '"') === -1) {
    errors.push({
      code: 'P1',
      message: 'Robots « ' + PUBLISHED_ROBOTS + ' » absent (post-traitement non appliqué)'
    });
  }
  if (text.indexOf('content="' + TEMPLATE_ROBOTS + '"') !== -1) {
    errors.push({
      code: 'P1b',
      message: 'Robots du gabarit « ' + TEMPLATE_ROBOTS + ' » encore présent'
    });
  }

  // Production — profondeur des assets (1 niveau : l'article vit dans
  // /blog/{lang}/, le gabarit écrit « assets/… » sans préfixe).
  // Un asset non réécrit reste à 0 niveau et 404 ; un asset déjà préfixé
  // serait remonté deux fois. Les deux sont donc refusés.
  var bareAssets = text.match(/(?:href|src)=["'](?:assets|css|js|icons|fonts)\//g);
  if (bareAssets) {
    errors.push({
      code: 'P2',
      message: 'Assets non réécrits (profondeur 0) : ' + unique(bareAssets).join(', ') +
        ' (attendu « ../ »)'
    });
  }
  var deepAssets = text.match(/(?:href|src)=["']\.\.\/\.\.\/(?:assets|css|js|icons|fonts)\//g);
  if (deepAssets) {
    errors.push({
      code: 'P2d',
      message: 'Assets à profondeur 2 niveaux : ' + unique(deepAssets).join(', ') +
        ' (attendu « ../ »)'
    });
  }
  if (text.indexOf('href="../assets/blog.css"') === -1) {
    errors.push({ code: 'P2b', message: 'assets/blog.css non résolu en ../assets/blog.css' });
  }
  // blog.js n'est pas référencé par le gabarit article : s'il apparaît, il
  // doit être à la bonne profondeur comme tout autre asset.
  if (/(?:href|src)=["']assets\/blog\.js/.test(text)) {
    errors.push({ code: 'P2e', message: 'assets/blog.js non résolu en ../assets/blog.js' });
  }

  // V9 — chaque ancre du sommaire existe dans le corps
  var anchors = [];
  var re = /<a href="#([^"]+)"/g;
  var m;
  while ((m = re.exec(text)) !== null) anchors.push(m[1]);
  var missingAnchors = anchors.filter(function (a) {
    return text.indexOf('id="' + a + '"') === -1;
  });
  if (missingAnchors.length) {
    errors.push({
      code: 'V9',
      message: 'Ancres sans cible : ' + unique(missingAnchors).join(', ')
    });
  }

  // V13 — unicité des id (invariant de production : le sommaire pointe par id)
  var ids = [];
  var idRe = /\sid="([^"]+)"/g;
  while ((m = idRe.exec(text)) !== null) ids.push(m[1]);
  var duplicateIds = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
  if (duplicateIds.length) {
    errors.push({
      code: 'V13',
      message: 'Identifiants dupliqués dans le HTML rendu : ' + unique(duplicateIds).join(', ')
    });
  }

  // Production — intégrité JSON-LD (parse réellement chaque bloc)
  var ldBlocks = text.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
  if (!ldBlocks.length) {
    errors.push({ code: 'P3', message: 'Aucun bloc JSON-LD dans le HTML rendu' });
  }
  ldBlocks.forEach(function (block, i) {
    var raw = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    if (parseJsonSafe(raw) === null) {
      errors.push({ code: 'P3b', message: 'JSON-LD #' + (i + 1) + ' invalide (non parsable)' });
    }
  });

  // Production — le suffixe de marque ne doit apparaître qu'une fois dans <title>
  var titleTag = /<title>([\s\S]*?)<\/title>/i.exec(text);
  if (!titleTag) {
    errors.push({ code: 'P3c', message: 'Balise <title> absente' });
  } else {
    var occurrences = titleTag[1].split(BRAND_SUFFIX).length - 1;
    if (occurrences !== 1) {
      errors.push({
        code: 'P3d',
        message: 'Suffixe de marque présent ' + occurrences + ' fois dans <title> (attendu 1)'
      });
    }
  }

  // Production — aucun attribut d'événement inline ni javascript: dans le rendu
  var scanForHandlers = stripGoogleFontLinks(withoutComments);
  var inlineHandlers = scanForHandlers.match(/\son(?:click|load|error|mouseover|focus)\s*=/gi);
  if (inlineHandlers) {
    errors.push({
      code: 'P4',
      message: 'Gestionnaires d\'événements inline détectés : ' + unique(inlineHandlers).join(', ')
    });
  }

  // Production — identité de la page : langue, direction, locale Open Graph
  if (expected && expected.lang) {
    var htmlTag = /<html[^>]*\slang="([^"]*)"[^>]*>/i.exec(text);
    var dirTag = /<html[^>]*\sdir="([^"]*)"[^>]*>/i.exec(text);
    if (!htmlTag || htmlTag[1] !== expected.lang) {
      errors.push({
        code: 'P5',
        message: 'Attribut lang attendu « ' + expected.lang + ' » (obtenu ' +
          (htmlTag ? htmlTag[1] : 'absent') + ')'
      });
    }
    if (!dirTag || dirTag[1] !== expected.dir) {
      errors.push({
        code: 'P5b',
        message: 'Attribut dir attendu « ' + expected.dir + ' » (obtenu ' +
          (dirTag ? dirTag[1] : 'absent') + ')'
      });
    }
    if (expected.ogLocale && getMetaContent(text, 'og:locale') !== expected.ogLocale) {
      errors.push({
        code: 'P5c',
        message: 'og:locale attendu « ' + expected.ogLocale + ' » (obtenu ' +
          getMetaContent(text, 'og:locale') + ')'
      });
    }
  }

  // Production — image de couverture : absolue en meta, racine-relative en <img>
  if (expected && expected.imagePath) {
    var imageUrl = buildSiteUrl(expected.imagePath);
    var ogImage = getMetaContent(text, 'og:image');
    if (ogImage !== imageUrl) {
      errors.push({
        code: 'P6',
        message: 'og:image attendu ' + imageUrl + ' (obtenu ' + (ogImage || 'absent') + ')'
      });
    }
    var twitterImage = getMetaContent(text, 'twitter:image');
    if (twitterImage !== imageUrl) {
      errors.push({
        code: 'P6b',
        message: 'twitter:image attendu ' + imageUrl + ' (obtenu ' + (twitterImage || 'absent') + ')'
      });
    }
    var ldImage = /"image":\s*\[\s*"([^"]*)"/i.exec(text);
    if (!ldImage || ldImage[1] !== imageUrl) {
      errors.push({
        code: 'P6c',
        message: 'JSON-LD image attendu ' + imageUrl + ' (obtenu ' + (ldImage ? ldImage[1] : 'absent') + ')'
      });
    }
    var heroImg = /<img[^>]*\ssrc="([^"]*)"[^>]*>/i.exec(text);
    if (!heroImg || heroImg[1] !== expected.imagePath) {
      errors.push({
        code: 'P6d',
        message: '<img src> attendu « ' + expected.imagePath + ' » (obtenu ' +
          (heroImg ? heroImg[1] : 'absent') + ')'
      });
    }
    var ogAlt = getMetaContent(text, 'og:image:alt');
    var heroAlt = /<img[^>]*\salt="([^"]*)"/i.exec(text);
    if (!ogAlt || !heroAlt || !ogAlt || ogAlt !== heroAlt[1]) {
      errors.push({
        code: 'P6e',
        message: 'og:image:alt et <img alt> doivent porter la même valeur non vide'
      });
    }
    [['og:image:width', expected.imageWidth], ['og:image:height', expected.imageHeight]]
      .forEach(function (pair) {
        var value = getMetaContent(text, pair[0]);
        if (String(value) !== String(pair[1])) {
          errors.push({
            code: 'P6f',
            message: pair[0] + ' attendu ' + pair[1] + ' (obtenu ' + (value || 'absent') + ')'
          });
        }
      });
  }

  // Production — dates et temps de lecture
  if (expected && expected.publishedIso) {
    var timeTag = /<time[^>]*\sdatetime="([^"]*)"/i.exec(text);
    if (!timeTag || timeTag[1] !== expected.publishedIso) {
      errors.push({
        code: 'P7',
        message: '<time datetime> attendu « ' + expected.publishedIso + ' » (obtenu ' +
          (timeTag ? timeTag[1] : 'absent') + ')'
      });
    }
    if (getMetaContent(text, 'article:published_time') !== expected.publishedIso) {
      errors.push({
        code: 'P7b',
        message: 'article:published_time attendu ' + expected.publishedIso
      });
    }
    if (expected.modifiedIso && getMetaContent(text, 'article:modified_time') !== expected.modifiedIso) {
      errors.push({
        code: 'P7c',
        message: 'article:modified_time attendu ' + expected.modifiedIso
      });
    }
  }
  var readingTag = /<span>\s*(\d+)\s*&nbsp;min\s*<\/span>/i.exec(text);
  if (!readingTag) {
    errors.push({ code: 'P7d', message: 'Temps de lecture absent (attendu « N&nbsp;min »)' });
  } else if (expected && expected.readingTime && readingTag[1] !== String(expected.readingTime)) {
    errors.push({
      code: 'P7e',
      message: 'Temps de lecture attendu ' + expected.readingTime + ' (obtenu ' + readingTag[1] + ')'
    });
  }

  // Production — catégorie : slug dans data-category, libellé dans le SEO
  if (expected && expected.categorySlug) {
    var dataCategory = /<article[^>]*\sdata-category="([^"]*)"/i.exec(text);
    if (!dataCategory || dataCategory[1] !== expected.categorySlug) {
      errors.push({
        code: 'P8',
        message: 'data-category attendu « ' + expected.categorySlug + ' » (obtenu ' +
          (dataCategory ? dataCategory[1] : 'absent') + ')'
      });
    }
  }
  if (expected && expected.categoryLabel) {
    if (getMetaContent(text, 'article:section') !== expected.categoryLabel) {
      errors.push({
        code: 'P8b',
        message: 'article:section attendu « ' + expected.categoryLabel + ' »'
      });
    }
    if (text.indexOf('"articleSection": "' + expected.categoryLabel + '"') === -1) {
      errors.push({
        code: 'P8c',
        message: 'JSON-LD articleSection attendu « ' + expected.categoryLabel + ' »'
      });
    }
  }

  // Production — hreflang : une URL absolue par langue publiée + x-default
  if (expected && expected.hreflang) {
    var alternates = {};
    var altRe = /<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"\s*\/?>/g;
    var alt;
    while ((alt = altRe.exec(text)) !== null) alternates[alt[1]] = alt[2];

    Object.keys(expected.hreflang).forEach(function (code) {
      if (alternates[code] !== expected.hreflang[code]) {
        errors.push({
          code: 'P9',
          message: 'hreflang ' + code + ' attendu ' + expected.hreflang[code] +
            ' (obtenu ' + (alternates[code] || 'absent') + ')'
        });
      }
    });
    Object.keys(alternates).forEach(function (code) {
      if (!Object.prototype.hasOwnProperty.call(expected.hreflang, code)) {
        errors.push({
          code: 'P9b',
          message: 'hreflang inattendu : ' + code + ' → ' + alternates[code]
        });
      }
    });
  }

  // Production — sélecteur de langue : un lien par langue, courante marquée
  if (expected && expected.lang) {
    var langNav = /<nav class="b-lang-art"[^>]*>([\s\S]*?)<\/nav>/i.exec(text);
    if (!langNav) {
      errors.push({ code: 'P10', message: 'Sélecteur de langue (.b-lang-art) absent' });
    } else {
      var anchors = langNav[1].match(/<a\s[^>]*>/g) || [];
      if (anchors.length !== APP.SUPPORTED_LANGS.length) {
        errors.push({
          code: 'P10b',
          message: 'Sélecteur de langue : ' + anchors.length + ' lien(s) (attendu ' +
            APP.SUPPORTED_LANGS.length + ')'
        });
      }
      APP.SUPPORTED_LANGS.forEach(function (code) {
        if (langNav[1].indexOf('hreflang="' + code + '"') === -1) {
          errors.push({ code: 'P10c', message: 'Lien de langue manquant : ' + code });
        }
      });
      // `aria-current` est cherché sur la balise <a> elle-même, pas comme
      // sous-chaîne : l'ordre des attributs n'appartient pas au contrat.
      var currentMarked = anchors.some(function (tag) {
        return tag.indexOf('hreflang="' + expected.lang + '"') !== -1 &&
          tag.indexOf('aria-current="true"') !== -1;
      });
      if (!currentMarked) {
        errors.push({
          code: 'P10d',
          message: 'Langue courante non marquée : aria-current manquant sur ' + expected.lang
        });
      }
      if (anchors.filter(function (tag) {
        return tag.indexOf('aria-current="true"') !== -1;
      }).length > 1) {
        errors.push({ code: 'P10f', message: 'Plusieurs liens de langue marqués aria-current' });
      }
      if (/href=""/.test(langNav[1])) {
        errors.push({ code: 'P10e', message: 'href vide dans le sélecteur de langue' });
      }
    }
  }

  // Production — un seul <h1>, non vide
  var h1s = text.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
  if (h1s.length !== 1) {
    errors.push({ code: 'P11', message: '<h1> attendu une fois (trouvé ' + h1s.length + ')' });
  } else if (!plainText(h1s[0]).trim()) {
    errors.push({ code: 'P11b', message: '<h1> vide' });
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Contrôle que la configuration est exploitable.
 *
 * Une clé est « manquante » si la ligne de Config est ABSENTE, pas si la
 * valeur est vide : PUBLISH_HOUR et PUBLISH_MINUTE sont volontairement vides
 * par défaut (l'heure est fixée à la phase planning). Les clés obligatoires
 * non vides sont, elles, contrôlées sur leur valeur.
 */
function validateConfig() {
  var errors = [];
  var map = readConfigMap();
  var absent = missingConfigKeys();

  absent.forEach(function (key) {
    errors.push({ code: 'C1', message: 'Ligne Config absente : ' + key });
  });

  // Clés qui doivent porter une valeur exploitable.
  ['AUTO_PUBLISH', 'ARTICLES_PER_DAY', 'ARTICLES_PER_WEEK', 'PUBLISH_DAYS',
    'MAX_ARTICLES_PER_RUN', 'MAX_RETRIES', 'SCHEDULE_MODE', 'CATEGORY_MAP'
  ].forEach(function (key) {
    if (map[key] === undefined || String(map[key]).trim() === '') {
      errors.push({ code: 'C1b', message: 'Config sans valeur : ' + key });
    }
  });

  var categories = getCategoryMap();
  if (!Object.keys(categories).length) {
    errors.push({
      code: 'C2',
      message: 'CATEGORY_MAP vide ou invalide : catégories inconnues impossibles à valider'
    });
  }

  // Cohérence planning (décision D5) : 6 articles, 3 jours, 2 exécutions.
  var perWeek = Number(map.ARTICLES_PER_WEEK);
  var days = String(map.PUBLISH_DAYS).split(',')
    .map(function (d) { return d.trim().toUpperCase(); })
    .filter(Boolean);
  if (isFinite(perWeek) && perWeek > 0) {
    if (!days.length) {
      errors.push({ code: 'C3', message: 'PUBLISH_DAYS vide alors que ARTICLES_PER_WEEK=' + perWeek });
    } else if (perWeek % days.length !== 0) {
      errors.push({
        code: 'C3b',
        message: 'ARTICLES_PER_WEEK (' + perWeek + ') n\'est pas répartissable ' +
          'également sur ' + days.length + ' jour(s)'
      });
    }
  }

  return { ok: errors.length === 0, errors: errors, warnings: [] };
}

/** Clés de CONFIG_KEYS dont la ligne est absente de la feuille Config. */
function missingConfigKeys() {
  var sheet = getConfigSheet();
  if (!sheet) return CONFIG_KEYS.slice();
  var present = {};
  var values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getValues();
  values.forEach(function (row) {
    var key = String(row[0] === null ? '' : row[0]).trim();
    if (key) present[key] = true;
  });
  return CONFIG_KEYS.filter(function (k) { return !present[k]; });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isBalancedHtml(html) {
  var s = String(html || '');
  var tags = s.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g) || [];
  var voids = ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'source'];
  var stack = [];
  for (var i = 0; i < tags.length; i++) {
    var tag = tags[i];
    var name = (tag.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)/) || [])[1];
    if (!name || voids.indexOf(name.toLowerCase()) !== -1) continue;
    if (tag.charAt(1) === '/') {
      if (stack.pop() !== name.toLowerCase()) return false;
    } else if (!/\/>$/.test(tag)) {
      stack.push(name.toLowerCase());
    }
  }
  return stack.length === 0;
}

function isRepoRelativeImage(url) {
  var s = String(url || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (/^\/\//.test(s)) return false;
  if (s.charAt(0) === '/') return true;
  return /^[A-Za-z0-9._\-/]+$/.test(s);
}

function stripHtmlComments(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, '');
}

function unique(list) {
  var seen = {};
  var out = [];
  list.forEach(function (v) {
    if (!seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}

/**
 * Extrait une valeur d'en-tête.
 * @param {string} html
 * @param {string} key 'canonical' | 'og:title' | 'description' | ...
 * @return {string} '' si absent
 */
function getMetaContent(html, key) {
  var s = String(html || '');

  if (key === 'canonical') {
    var link = /<link[^>]*rel="canonical"[^>]*>/i.exec(s);
    if (!link) return '';
    var href = /href="([^"]*)"/i.exec(link[0]);
    return href ? href[1] : '';
  }

  var nameRe = new RegExp(
    '<meta[^>]*name="' + escapeRegExp(key) + '"[^>]*>', 'i');
  var propRe = new RegExp(
    '<meta[^>]*property="' + escapeRegExp(key) + '"[^>]*>', 'i');
  var tag = nameRe.exec(s) || propRe.exec(s);
  if (!tag) return '';

  var content = /content="([^"]*)"/i.exec(tag[0]);
  return content ? content[1] : '';
}

/** Échappe une chaîne pour usage dans une RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
