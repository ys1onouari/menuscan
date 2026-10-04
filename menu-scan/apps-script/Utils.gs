/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Utils.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : primitives pures (échappement, slugs, dates
 * multilingues, chemins, temps de lecture, JSON) + couche d'appel HTTP avec
 * retry borné.
 *
 * Aucune dépendance à Google Sheets, à GitHub ou à un état global : ce module
 * est chargeable et testable isolément.
 *
 * PHASE 2 — fondation. Aucune publication n'est possible depuis ce module
 * (les écritures sont verrouillées par Github.gs / GITHUB_WRITE_ENABLED).
 */

/** Constantes de l'application — aucune valeur secrète ici. */
var APP = {
  /**
   * Identifiants du dépôt : VOLONTAIREMENT VIDES.
   *
   * Le dépôt, son propriétaire et sa branche ne sont JAMAIS écrits en dur :
   * ils sont lus exclusivement dans les Script Properties GITHUB_OWNER,
   * GITHUB_REPOSITORY et GITHUB_BRANCH (Config.gs). Une valeur figée ici
   * publishierait par erreur, y compris sur un fork.
   */
  OWNER: '',
  REPOSITORY: '',
  BRANCH: '',
  API_BASE: 'https://api.github.com',

  // Domaine canonique. Toute URL générée passe par buildSiteUrl() (Config.gs),
  // qui refuse toute autre origine.
  SITE_ORIGIN: 'https://menuscan.space',

  /**
   * WhatsApp du CTA et du pied de page article. Source unique : le même
   * numéro est utilisé par la page d'accueil, donc il ne doit pas être recopié
   * dans les gabarits ni dans les libellés.
   */
  WHATSAPP_URL: 'https://wa.me/212630230803',

  /**
   * MIROIR du champ `timeZone` de `appsscript.json`. Sert UNIQUEMENT à
   * `assertTimeZoneConsistency()`, qui refuse toute divergence avec Config.
   * Ce n'est PAS une source de fuseau : aucun calcul de date ni le scheduler
   * ne doit lire cette valeur (ils lisent `getConfiguredTimeZone()`).
   */
  MANIFEST_TIMEZONE: 'Africa/Casablanca',

  /**
   * Chemins du dépôt. Le site est un projet Vite : `public/` est la racine
   * web, tout le reste (index.html racine, src/) n'est pas publié tel quel.
   * Les chemins ci-dessous sont donc RELATIFS À `public/`.
   */
  BLOG_DIR: 'public/blog',
  TEMPLATE_PATH: 'public/blog/template-article.html',
  HUB_PATH: 'public/blog/index.html',
  ARTICLES_INDEX_PATH: 'public/blog/articles.json',
  BLOG_ASSETS_DIR: 'public/blog/assets',
  BLOG_IMAGES_DIR: 'public/blog/images',
  SITEMAP_PATH: 'public/sitemap.xml',

  /**
   * Langues du blog. `DEFAULT_LANG` sert de repli et de=x-default des
   * hreflang ; `RTL_LANGS` est la liste closed des langues `dir="rtl"`.
   * Un `dir` n'est jamais déduit d'une locale navigateur : il vient d'ici.
   */
  SUPPORTED_LANGS: ['fr', 'en', 'es', 'ar'],
  DEFAULT_LANG: 'fr',
  RTL_LANGS: ['ar'],

  /**
   * Bucket « aucune catégorie », utilisé quand la colonne CATEGORY est vide.
   * C'est un slug comme un autre : l'article reste publié, indexé et filtrable.
   */
  FALLBACK_CATEGORY: 'sans-categorie',

  /** Profondeur du dossier d'un article : /blog/{lang}/{slug}.html → 1 niveau. */
  ARTICLE_DEPTH_PREFIX: '../',

  /**
   * Pages publiées utilisées par verifySiteOriginFromRepository() (D9).
   * Le gabarit est volontairement exclu de ce tableau : ses URLs sont des
   * placeholders, il est chargé séparément par TemplateLoader.
   */
  CANONICAL_SAMPLES: [
    'public/blog/index.html',
    'public/blog/articles.json',
    'public/sitemap.xml',
    'public/robots.txt'
  ],

  MAX_DESCRIPTION: 160,
  MAX_TEMPLATE_BYTES: 262144,
  RETRYABLE_STATUS: [429, 500, 502, 503],
  BACKOFF_BASE_MS: 1000,
  BACKOFF_MAX_MS: 30000
};

/* -------------------------------------------------------------------------- */
/* Échappement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Suffixe de marque du <title> — em dash (U+2014), identique à la production.
 * Source UNIQUE du suffixe : le gabarit ne le porte pas (il est injecté au
 * rendu), seul le <title> le reçoit, et il ne doit jamais apparaître deux fois.
 */
var BRAND_SUFFIX = ' — Blog Menu Scan';

/**
 * Échappe une valeur destinée au HTML (texte ou attribut).
 * Utilisé par TOUTE insertion dans le HTML généré et par les logs.
 */
function escHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Échappe une valeur destinée à une chaîne JSON (sans les guillemets). */
function escJson(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Neutralise les motifs de script dans tout champ saisi (défense en profondeur). */
function containsScript(value) {
  if (value === null || value === undefined) return false;
  var s = String(value).toLowerCase();
  return s.indexOf('<script') !== -1 ||
    s.indexOf('onerror=') !== -1 ||
    s.indexOf('onload=') !== -1 ||
    s.indexOf('javascript:') !== -1;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Slug ASCII en minuscules. Utilisé UNIQUEMENT pour le SLUG d'article
 * et pour la suggestion dérivée de KEYWORD.
 * NE DOIT PAS servir à dériver un slug de catégorie : voir Config.gs / CATEGORY_MAP
 * (décision D2 — « TVA Maroc » → « tva » n'est pas dérivable).
 */
function slugify(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** true si le slug est strictement conforme : [a-z0-9-], pas de bord. */
function isValidSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ''));
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Décalage en minutes du fuseau configuré, à l'instant `date`.
 *
 * Dérivé de `getConfiguredTimeZone()` — aucune valeur de fuseau n'est écrite
 * en dur ici. Passé à 00 h 30 au Maroc (UTC+1), l'instant est encore la
 * veille en UTC : sans cette correction, `PUBLISHED_AT` serait daté à tort.
 *
 * @return {number} minutes (ex. 60 pour Africa/Casablanca)
 */
function zoneOffsetMinutes(date) {
  var zone = getConfiguredTimeZone();
  var instant = date || new Date();
  try {
    var formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    var parts = {};
    formatter.formatToParts(instant).forEach(function (p) {
      parts[p.type] = p.value;
    });
    var asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return Math.round((asUtc - instant.getTime()) / 60000);
  } catch (e) {
    // Fuseau inconnu de l'environnement : UTC reste un repli sûr et explicite.
    return 0;
  }
}

/**
 * 'YYYY-MM-DD' de la date de publication, dans le fuseau CONFIGURÉ.
 * Idempotent : deux exécutions le même jour donnent la même chaîne.
 */
function toIsoDate(date) {
  var instant = date || new Date();
  var local = new Date(instant.getTime() + zoneOffsetMinutes(instant) * 60000);
  return local.getUTCFullYear() + '-' +
    pad2(local.getUTCMonth() + 1) + '-' +
    pad2(local.getUTCDate());
}

/** '14 juillet 2026' depuis 'YYYY-MM-DD'. Renvoie '' si l'entrée est invalide. */
function frenchDate(iso) {
  return formatDate(iso, 'fr');
}

/**
 * 'YYYY-MM-DD' depuis TOUTE forme de date de la feuille `Articles`.
 *
 * La colonne PUBLISHED_AT contient trois formes réellement rencontrées :
 *   - une VRAIE date Google Sheets (objet `Date`) quand la cellule est formatée
 *     en date ;
 *   - une chaîne ISO 'YYYY-MM-DD' saisie à la main ;
 *   - une chaîne de date JavaScript produite par `String()` — « Sat Oct 03
 *     2026 22:00:00 GMT+0000 (heure normale d'Europe de l'Ouest) » — qui
 *     apparaissait dès qu'une lecture convertissait la cellule trop tôt.
 *
 * Les trois donnent la MÊME sortie, dans le fuseau CONFIGURÉ : c'est ce qui rend
 * la publication idempotente et l'index réconciliable quelle que soit la forme
 * de saisie. Une valeur illisible rend '' et n'INVENTE jamais de date.
 *
 * Fonction PUR.
 *
 * @param {*} value Date, chaîne ou valeur vide
 * @return {string} 'YYYY-MM-DD', ou '' si la valeur est absente/illisible
 */
function normalizePublishedAt(value) {
  if (value === null || value === undefined) return '';

  // Vraie date de cellule : formatée directement, sans passer par `String()`.
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? '' : toIsoDate(value);
  }

  var raw = String(value).trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Saisie française « 14/07/2026 » : `new Date()` la rejette (format ambigu).
  var fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (fr) return toIsoDate(new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]), 12, 0, 0));

  // Chaîne de date lisible : réanalysée puis rendue dans le fuseau configuré.
  var parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? '' : toIsoDate(parsed);
}

/**
 * Noms de mois, par langue — INDEX 0 = janvier.
 *
 * Table EXPLICITE plutôt qu'`Intl.DateTimeFormat` : le rendu doit être
 * déterministe d'une exécution à l'autre. ICU varie selon la version
 * (« 2 févr. », espace fine insécable avant l'année en fr-FR, chiffres
 * arabo-indiens en ar-EG), ce qui produirait des pages différentes d'une
 * exécution à l'autre et des dates illisibles en arabe.
 */
var MONTH_NAMES = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
};

/**
 * Motif de composition par langue. `{d}`, `{m}` et `{y}` reçoivent des
 * chaînes déjà converties en chiffres 0-9.
 */
var DATE_PATTERNS = {
  fr: '{d} {m} {y}',
  en: '{m} {d}, {y}',
  es: '{d} de {m} de {y}',
  ar: '{d} {m} {y}'
};

/**
 * Chiffres 0-9, quelle que soit la langue.
 *
 * La sortie de formatDate est construite depuis des entiers : elle est donc
 * latine par construction. L'ENTRÉE est en revanche normalisée, car une
 * feuille peut contenir des chiffres arabo-indiens saisis sur un clavier
 * arabe : la date resterait sinon illisible pour le lecteur.
 */
function toLatinDigits(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
    .replace(/[\u06F0-\u06F9]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
}

/**
 * Date formatée en `lang` (fr, en, es, ar) depuis 'YYYY-MM-DD'.
 *
 * Chiffres 0-9 garantis, espaces ordinaires, mois issu de MONTH_NAMES.
 * Renvoie '' si l'entrée est invalide ou si la langue est inconnue : une date
 * non formatable doit devenir une erreur bloquante côté Validator, jamais un
 * `undefined` dans le HTML.
 *
 * @param {string} iso 'YYYY-MM-DD'
 * @param {string} lang code de langue
 * @return {string} ex. '2 février 2026' / 'February 2, 2026' / '2 de febrero de 2026'
 */
function formatDate(iso, lang) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toLatinDigits(iso).trim());
  if (!m) return '';
  var months = MONTH_NAMES[lang];
  var pattern = DATE_PATTERNS[lang];
  if (!months || !pattern) return '';
  var month = months[parseInt(m[2], 10) - 1];
  if (!month) return '';
  return pattern
    .replace('{d}', String(parseInt(m[3], 10)))
    .replace('{m}', month)
    .replace('{y}', m[1]);
}

/** Horodatage ISO complet pour la feuille Logs. */
function nowIso() {
  return new Date().toISOString();
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/* -------------------------------------------------------------------------- */
/* Lecture du contenu                                                        */
/* -------------------------------------------------------------------------- */

/** Retire balises et entités pour compter les mots du corps de l'article. */
function plainText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Temps de lecture déterministe : 200 mots/minute, minimum 1.
 * Le gabarit ne définit aucune formule (Phase 1, §2) : la valeur est
 * arbitraire mais stable et documentée.
 */
function readingTime(html) {
  var words = plainText(html).split(' ').filter(function (w) { return w.length > 0; });
  if (!words.length) return 1;
  return Math.max(1, Math.round(words.length / 200));
}

/* -------------------------------------------------------------------------- */
/* Chemins                                                                     */
/* -------------------------------------------------------------------------- */

/** La langue est-elle supportée par le blog ? */
function isSupportedLang(lang) {
  return APP.SUPPORTED_LANGS.indexOf(String(lang || '').trim()) === -1
    ? false
    : true;
}

/** `dir` d'une langue : seul `ar` est RTL. Source unique : APP.RTL_LANGS. */
function dirForLang(lang) {
  return APP.RTL_LANGS.indexOf(String(lang || '').trim()) === -1 ? 'ltr' : 'rtl';
}

/**
 * Chemin REPO d'un article : public/blog/{lang}/{slug}.html
 *
 * La langue fait partie du chemin : deux traductions du même contenu ont
 * deux chemins distincts. Aucun `..`, aucune traversée, un seul niveau.
 */
function blogPath(lang, slug) {
  return APP.BLOG_DIR + '/' + lang + '/' + slug + '.html';
}

/** Chemin WEB (canonical) d'un article : /blog/{lang}/{slug}.html */
function sitePath(lang, slug) {
  return '/' + APP.BLOG_DIR.replace(/^public\//, '') + '/' + lang + '/' + slug + '.html';
}

/**
 * Chemin WEB du hub : /blog/index.html
 *
 * Forme `index.html` et non `/blog/` : c'est celle qu'emploient les articles
 * publiés pour le sélecteur de langue (`?lang=xx`) et elle ne dépend d'aucune
 * réécriture d'URL côté serveur.
 */
function siteHubPath() {
  return '/' + APP.HUB_PATH.replace(/^public\//, '');
}

/**
 * Chemin WEB de la racine du Blog : /blog/
 *
 * Distingué de `siteHubPath()` (`/blog/index.html`) : les liens de navigation
 * «_dirigés vers le Blog» du gabarit et le bouton secondaire du CTA pointent
 * sur la racine, sans nom de fichier, comme le fait la production publiée.
 */
function siteBlogRootPath() {
  return '/' + APP.BLOG_DIR.replace(/^public\//, '') + '/';
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

function parseJsonSafe(raw) {
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    return null;
  }
}

/** Sérialisation JSON compacte et stable (une ligne). */
function toJson(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

function backoffMs(attempt) {
  var base = APP.BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
  var jittered = base * (0.5 + Math.random() * 0.5);
  return Math.min(APP.BACKOFF_MAX_MS, Math.round(jittered));
}

/**
 * Appel HTTP avec retry limité aux erreurs RÉCUPÉRABLES.
 * Ne réessaie jamais un 4xx (401/403/404/422) : ces erreurs sont définitives
 * et un nouvel essai ne ferait qu'aggraver le rate limit.
 *
 * @param {{url:string, method?:string, headers?:Object, payload?:*|null,
 *          retries?:number}} opt
 * @return {Object} réponse UrlFetchApp (muteHttpExceptions: true)
 * @throws {Error} après épuisement des tentatives, message sans secret
 */
function httpRequest(opt) {
  var url = opt.url;
  var retries = typeof opt.retries === 'number' ? opt.retries : 0;
  var attempt = 0;

  while (true) {
    var response = null;
    var transportError = null;

    try {
      response = UrlFetchApp.fetch(url, {
        method: (opt.method || 'get').toUpperCase(),
        headers: opt.headers || {},
        payload: opt.payload === undefined ? null : opt.payload,
        muteHttpExceptions: true,
        validateHttpsCertificates: true,
        followRedirects: true
      });
    } catch (e) {
      transportError = e;
    }

    if (response) {
      var status = response.getResponseCode();
      if (APP.RETRYABLE_STATUS.indexOf(status) === -1 || attempt >= retries) {
        return response;
      }
      // Statut récupérable mais tentatives épuisées : on rend la réponse
      // pour que l'appelant décide (message d'erreur précis).
      if (attempt >= retries) return response;
    } else if (transportError) {
      if (attempt >= retries) {
        throw new Error('Transport GitHub: ' + transportError.message);
      }
    }

    attempt += 1;
    Utilities.sleep(backoffMs(attempt));
  }
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Retire tout motif ressemblant à un secret d'un message destiné aux Logs
 * ou à l'UI. Dernière barrière : le token ne doit jamais fuir (Phase 1, §6.2).
 */
function redact(message) {
  if (message === null || message === undefined) return '';
  var s = String(message);
  s = s.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED]');
  s = s.replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]');
  s = s.replace(/(authorization"?\s*[:=]\s*"?)(token|bearer)?\s*[A-Za-z0-9._-]{8,}/gi,
    '$1[REDACTED]');
  return s;
}
