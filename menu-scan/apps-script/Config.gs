/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Config.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : lecture/écriture de la configuration.
 *   1. Script Properties (secrets + identifiants du dépôt) — jamais dans Sheets,
 *      jamais dans les logs, jamais affichés en clair.
 *   2. Feuille `Config` (valeurs métier, éditables sans redéploiement).
 *   3. Tables de référence : catégories (slug → slug), libellés par langue,
 *      hôtes d'images autorisés.
 *
 * Aucun identifiant de dépôt n'est écrit en dur : ils viennent des Script
 * Properties (voir getGithubOwner/Repository/Branch).
 *
 * PHASE 2 — fondation. Aucune publication.
 */

/* -------------------------------------------------------------------------- */
/* Clés                                                                       */
/* -------------------------------------------------------------------------- */

/** Clés stockées en Script Properties. */
var PROP_KEYS = {
  TOKEN: 'GITHUB_TOKEN',
  OWNER: 'GITHUB_OWNER',
  REPOSITORY: 'GITHUB_REPOSITORY',
  BRANCH: 'GITHUB_BRANCH',
  API_BASE: 'GITHUB_API_BASE',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  WRITE_ENABLED: 'GITHUB_WRITE_ENABLED',
  SITE_ORIGIN: 'SITE_ORIGIN',
  // Sous-dossier du dépôt qui contient le projet (ex. « menu-scan »). Vide par
  // défaut. Appliqué UNIQUEMENT à la frontière réseau de Github.gs.
  PATH_PREFIX: 'GITHUB_PATH_PREFIX'
};

/** Clés de la feuille `Config` (ordre d'affichage imposé par la mission). */
var CONFIG_KEYS = [
  'AUTO_PUBLISH',
  'ARTICLES_PER_DAY',
  'PUBLISH_HOUR',
  'PUBLISH_MINUTE',
  'TIMEZONE',
  'ENABLE_FEATURED_IMAGE',
  'TEST_MODE',
  'MAX_ARTICLES_PER_RUN',
  'MAX_RETRIES',
  'SCHEDULE_MODE',
  'ARTICLES_PER_WEEK',
  'PUBLISH_DAYS',
  'CATEGORY_MAP',
  'IMAGE_ALLOWED_HOSTS'
];

/** Valeurs par défaut. */
var CONFIG_DEFAULTS = {
  AUTO_PUBLISH: 'TRUE',
  ARTICLES_PER_DAY: '1',
  PUBLISH_HOUR: '',
  PUBLISH_MINUTE: '',
  // Même fuseau que le manifeste (appsscript.json). Aucun second fuseau caché :
  // l'horodatage de publication et le scheduler doivent lire CETTE valeur.
  // (Écart Europe/Paris corrigé : +2 h en été contre +1 h au Maroc.)
  TIMEZONE: 'Africa/Casablanca',
  // L'image à la une est ACTIVÉE : le gabarit expose ARTICLE_IMAGE, IMAGE_ALT,
  // IMAGE_WIDTH et IMAGE_HEIGHT. Une URL d'image est requise pour un article
  // PUBLISHED ; le moteur n'invente jamais d'image de repli.
  ENABLE_FEATURED_IMAGE: 'TRUE',
  // PHASE 4 : le mode test est le défaut. Le moteur de publication
  // (Publisher.gs) rend ET valide l'article, puis s'arrête : la levée du
  // mode test est un acte délibéré du Product Owner, jamais un effet de bord.
  // GITHUB_WRITE_ENABLED (Script Property) reste FALSE par défaut : les deux
  // verrous doivent être ouverts pour qu'un commit existe.
  TEST_MODE: 'TRUE',
  MAX_ARTICLES_PER_RUN: '1',
  MAX_RETRIES: '3',
  SCHEDULE_MODE: 'WEEKLY',
  ARTICLES_PER_WEEK: '6',
  PUBLISH_DAYS: 'TUESDAY,FRIDAY',
  // Décision D2 : correspondance EXPLICITE slug → slug, jamais dérivée par
  // slugify(). La feuille `Config` reste la source éditable sans redéploiement ;
  // CATEGORY_SLUGS (ci-dessous) est la liste de référence du code, utilisée
  // comme repli et pour le menu déroulant.
  CATEGORY_MAP: JSON.stringify({
    'menu-digital': 'menu-digital',
    'qr-code': 'qr-code',
    'restaurants-cafes': 'restaurants-cafes',
    'hotels-riads': 'hotels-riads',
    'commerces': 'commerces',
    'guides-prix': 'guides-prix'
  }),
  // Liste JSON d'hôtes autorisée pour une image EXTERNE (https). Vide = refus
  // par défaut : seules les images du dépôt (/blog/images/…) sont acceptées.
  // Ajouter un hôte est un acte délibéré du Product Owner.
  IMAGE_ALLOWED_HOSTS: '[]'
};

/** Clés legacy WordPress : conservées, affichées, JAMAIS exécutées. */
var CONFIG_LEGACY = [
  'WORDPRESS_URL',
  'WORDPRESS_DEFAULT_STATUS',
  'CREATE_MISSING_CATEGORIES'
];

/* -------------------------------------------------------------------------- */
/* Script Properties                                                          */
/* -------------------------------------------------------------------------- */

function propGet(key) {
  try {
    return PropertiesService.getScriptProperties().getProperty(key) || '';
  } catch (e) {
    return '';
  }
}

function propSet(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function propDelete(key) {
  PropertiesService.getScriptProperties().deleteProperty(key);
}

/**
 * Token GitHub. Usage unique : l'en-tête d'autorisation de Github.gs.
 * Ne jamais appeler cette fonction depuis un log, un message d'erreur ou l'UI.
 */
function getGithubToken() {
  return propGet(PROP_KEYS.TOKEN);
}

/**
 * Lecture d'une Script Property obligatoire.
 *
 * Les identifiants du dépôt ne sont JAMAIS codés en dur (APP.OWNER,
 * APP.REPOSITORY et APP.BRANCH sont vides) : une valeur figée publishierait
 * par erreur, y compris sur un fork. L'absence doit donc être une erreur
 * explicite, pas une chaîne vide qui se propage jusqu'à l'API GitHub.
 *
 * @throws {Error} si la propriété est absente ou vide
 * @return {string} valeur non vide
 */
function requiredProp(key, label) {
  var value = propGet(key).trim();
  if (!value) {
    throw new Error(
      'Script Property « ' + key + ' » absente' + (label ? ' (' + label + ')' : '') +
      '. Renseignez-la dans Paramètres du projet → Propriétés du script.'
    );
  }
  return value;
}

/**
 * Lecture « douce » : renvoie '' au lieu de lever. Réservée aux chemins de
 * diagnostic (testGithubConnection) qui doivent RAPPORTER une anomalie au
 * lieu de s'interrompre.
 *
 * @return {string} valeur brute, '' si absente
 */
function optionalProp(key) {
  try {
    return propGet(key).trim();
  } catch (e) {
    return '';
  }
}

function getGithubOwner() {
  return requiredProp(PROP_KEYS.OWNER, 'propriétaire du dépôt');
}

function getGithubRepository() {
  return requiredProp(PROP_KEYS.REPOSITORY, 'nom du dépôt');
}

function getGithubBranch() {
  return requiredProp(PROP_KEYS.BRANCH, 'branche de publication');
}

function getGithubApiBase() {
  return (propGet(PROP_KEYS.API_BASE) || APP.API_BASE).replace(/\/+$/, '');
}

/**
 * Verrou d'écriture. Défaut FALSE : la fondation ne peut structurellement
 * produire aucun commit. Levé explicitement par le Product Owner lors du
 * pilote, jamais automatiquement — et jamais seul : TEST_MODE doit aussi
 * valoir FALSE (Publisher.gs, assertWritesAllowed).
 */
function writesEnabled() {
  return propGet(PROP_KEYS.WRITE_ENABLED).toUpperCase() === 'TRUE';
}

function setWritesEnabled(enabled) {
  propSet(PROP_KEYS.WRITE_ENABLED, enabled ? 'TRUE' : 'FALSE');
}

/**
 * Domaine canonique : https://menuscan.space
 *
 * Constante issue de l'audit (Phase 1, §1.1). Un opérateur PEUT surcharger
 * via la Script Property SITE_ORIGIN, mais l'override doit être strictement
 * identique à la valeur vérifiée : toute autre valeur est refusée. Le garde-fou
 * protège désormais contre TOUT autre domaine, et plus seulement contre
 * l'ancien.
 */
function getSiteOrigin() {
  var override = propGet(PROP_KEYS.SITE_ORIGIN).replace(/\/+$/, '');
  return override || APP.SITE_ORIGIN;
}

/**
 * Décision D9 — garde-fou local, sans réseau.
 * Vérifie que l'origine effective est bien celle validée en Phase 1.
 * Appelée par buildSiteUrl(), donc à chaque construction d'URL.
 *
 * @throws {Error} si une origine non validée est configurée
 */
function assertSiteOrigin() {
  var effective = getSiteOrigin();
  if (effective !== APP.SITE_ORIGIN) {
    throw new Error(
      'SITE_ORIGIN non conforme : « ' + effective + ' » (valeur validée : ' +
      APP.SITE_ORIGIN + '). Corrigez la Script Property ' + PROP_KEYS.SITE_ORIGIN + '.'
    );
  }
  return effective;
}

/**
 * Hôtes tiers autorisés dans les pages publiées.
 *
 * Liste établie par un scan RÉEL du dépôt (index.html racine, hub, articles
 * publiés, articles.json, sitemap, robots.txt) : polices Google, JSON-LD
 * schema.org, namespace SVG w3.org, lien WhatsApp, lien Instagram, schéma
 * sitemaps.org. Toute autre origine dans une page publiée est une divergence
 * à corriger, pas un détail à ignorer.
 */
var WEB_ALLOWED_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'instagram.com',
  'schema.org',
  'wa.me',
  'www.sitemaps.org',
  'www.w3.org'
];

/** Hôte d'une URL ou d'une origine, en minuscules, sans port. */
function hostOf(url) {
  return String(url || '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}

/**
 * Décision D9 — vérification RÉELLE contre le dépôt, en lecture seule.
 * Confirme que les pages publiées utilisent bien l'origine validée, avant
 * toute génération d'URL. Appelée explicitement par le moteur (pas par
 * buildSiteUrl, pour ne pas introduire d'E/S réseau dans une fonction pure).
 *
 * @return {{ok:boolean, expected:string, found:string[], filesChecked:number}}
 * @throws {Error} si une page publiée diverge
 */
function verifySiteOriginFromRepository() {
  var expected = assertSiteOrigin();
  var found = [];
  var checked = 0;

  var samples = [APP.TEMPLATE_PATH].concat(APP.CANONICAL_SAMPLES || []);
  samples.forEach(function (path) {
    var file = getFile(path);
    if (!file) return;
    checked += 1;
    var re = /https?:\/\/[a-z0-9.-]+/gi;
    var m;
    while ((m = re.exec(file.content)) !== null) {
      if (found.indexOf(m[0]) === -1) found.push(m[0]);
    }
  });

  if (!checked) {
    throw new Error(
      'Vérification canonique impossible : aucune page lisible dans le dépôt. ' +
      'Contrôle manuel requis avant publication.'
    );
  }

  var expectedHost = hostOf(expected);
  var foreign = found.filter(function (origin) {
    var host = hostOf(origin);
    if (host === expectedHost) return false;
    return WEB_ALLOWED_HOSTS.indexOf(host) === -1;
  });

  if (foreign.length) {
    throw new Error(
      'Origine canonique incohérente dans le dépôt : ' + foreign.join(', ') +
      ' (attendu ' + expected + ')'
    );
  }

  return { ok: true, expected: expected, found: found, filesChecked: checked };
}

/**
 * Fuseau de référence unique de la publication.
 *
 * Source de vérité : la feuille `Config` (clé TIMEZONE), ce qui permet de la
 * corriger sans redéploiement. Le manifeste `appsscript.json` déclare le même
 * fuseau : `assertTimeZoneConsistency()` refuse toute divergence, de sorte
 * qu'aucun second fuseau ne puisse se glisser en silence.
 */
function getConfiguredTimeZone() {
  return getConfigValue('TIMEZONE').trim() || CONFIG_DEFAULTS.TIMEZONE;
}

/**
 * Vérifie que Config et le manifeste désignent le même fuseau.
 * @throws {Error} en cas de divergence
 */
function assertTimeZoneConsistency() {
  var configured = getConfiguredTimeZone();
  if (configured !== APP.MANIFEST_TIMEZONE) {
    throw new Error(
      'Divergence de fuseau : Config TIMEZONE=' + configured +
      ' alors que appsscript.json déclare ' + APP.MANIFEST_TIMEZONE + '.'
    );
  }
  return configured;
}

/** URL absolue d'un chemin Blog, ex. buildSiteUrl('/blog/tva/'). */
function buildSiteUrl(path) {
  assertSiteOrigin();
  var p = String(path || '');
  if (p.charAt(0) !== '/') p = '/' + p;
  return getSiteOrigin() + p;
}

/* -------------------------------------------------------------------------- */
/* Feuille Config                                                             */
/* -------------------------------------------------------------------------- */

function getConfigSheet() {
  return getSheetByName(SHEETS.CONFIG);
}

/**
 * Feuille Config sous forme de Map (clé → valeur texte).
 * Les clés absentes retombent sur CONFIG_DEFAULTS.
 */
function readConfigMap() {
  var out = {};
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) { out[k] = CONFIG_DEFAULTS[k]; });
  var sheet = getConfigSheet();
  if (!sheet) return out;

  var values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getValues();
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0] === null ? '' : values[i][0]).trim();
    if (!key) continue;
    out[key] = values[i][1] === null ? '' : String(values[i][1]);
  }
  return out;
}

/** Valeur brute (texte) d'une clé de configuration. */
function getConfigValue(key) {
  var map = readConfigMap();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
}

function getConfigBoolean(key) {
  return getConfigValue(key).trim().toUpperCase() === 'TRUE';
}

function getConfigNumber(key, fallback) {
  var raw = getConfigValue(key).trim();
  if (raw === '') return fallback;
  var n = Number(raw);
  return isFinite(n) ? n : fallback;
}

/** Écrit une valeur dans la colonne B de la ligne de la clé (crée la ligne si besoin). */
function setConfigValue(key, value) {
  var sheet = getConfigSheet();
  if (!sheet) throw new Error('Feuille Config introuvable');
  var last = sheet.getLastRow();
  for (var r = 1; r <= last; r++) {
    if (String(sheet.getRange(r, 1).getValue()).trim() === key) {
      sheet.getRange(r, 2).setValue(String(value));
      return;
    }
  }
  sheet.appendRow([key, String(value)]);
}

/**
 * Écrit la feuille Config si elle est absente ou incomplète.
 * Ne supprime jamais une clé existante et ne réécrit pas une valeur présente.
 */
function ensureConfigSheet() {
  var sheet = getSheetByNameOrCreate(SHEETS.CONFIG);
  var created = [];

  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, 2).setValues([['KEY', 'VALUE']]);
    created.push('en-têtes');
  }

  CONFIG_KEYS.forEach(function (key) {
    if (findConfigRow(sheet, key) === 0) {
      sheet.appendRow([key, CONFIG_DEFAULTS[key]]);
      created.push(key);
    }
  });

  // Legacy : présents, marqués, jamais exécutés.
  CONFIG_LEGACY.forEach(function (key) {
    if (findConfigRow(sheet, key) === 0) {
      sheet.appendRow([key, 'LEGACY / NOT USED']);
      created.push(key + ' (legacy)');
    }
  });

  return created;
}

function findConfigRow(sheet, key) {
  var last = sheet.getLastRow();
  for (var r = 1; r <= last; r++) {
    if (String(sheet.getRange(r, 1).getValue()).trim() === key) return r;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Tables de référence : catégories, libellés, hôtes d'images                 */
/* -------------------------------------------------------------------------- */

/**
 * Liste de référence des catégories (code).
 *
 * SOURCE UNIQUE de l'appartenance d'un slug à une catégorie : le menu
 * déroulant de la feuille Articles, la validation et le repli de CATEGORY_MAP
 * s'appuient tous sur cette liste. La feuille `Config` peut redéfinir la
 * correspondance slug → slug, jamais inventer une catégorie hors de cette liste.
 */
var CATEGORY_SLUGS = [
  'menu-digital',
  'qr-code',
  'restaurants-cafes',
  'hotels-riads',
  'commerces',
  'guides-prix'
];

/**
 * Libellé localisé de chaque catégorie, par langue.
 *
 * Les chaînes sont IDENTIQUES à celles de public/blog/assets/blog.js (le hub
 * déjà en ligne) : un article et son filtre de hub doivent afficher le même
 * texte. Le `&` est stocké brut ; l'échappement HTML est fait à l'écriture
 * par le Renderer.
 */
var CATEGORY_LABELS = {
  'menu-digital': {
    fr: 'Menu digital',
    en: 'Digital menu',
    es: 'Menú digital',
    ar: 'قائمة رقمية'
  },
  'qr-code': {
    fr: 'QR Code',
    en: 'QR Code',
    es: 'Código QR',
    ar: 'رمز QR'
  },
  'restaurants-cafes': {
    fr: 'Restaurants & cafés',
    en: 'Restaurants & cafés',
    es: 'Restaurantes y cafés',
    ar: 'مطاعم ومقاهي'
  },
  'hotels-riads': {
    fr: 'Hôtels & riads',
    en: 'Hotels & riads',
    es: 'Hoteles y riads',
    ar: 'فنادق ورياض'
  },
  'commerces': {
    fr: 'Commerces',
    en: 'Retail',
    es: 'Comercios',
    ar: 'محلات تجارية'
  },
  'guides-prix': {
    fr: 'Guides & prix',
    en: 'Guides & pricing',
    es: 'Guías y precios',
    ar: 'أدلة وأسعار'
  }
};

/**
 * Libellés d'interface du gabarit, par langue — SOURCE UNIQUE.
 *
 * Ces neuf clés couvrent TOUT le texte de navigation, de pied de page, de
 * sommaire et de sélecteur de langue du gabarit. Le Renderer n'a plus le
 * droit de contenir une chaîne en dur : il appelle getLabel().
 */
var LABELS = {
  NAV_ARIA: {
    fr: 'Navigation principale du blog',
    en: 'Blog main navigation',
    es: 'Navegación principal del blog',
    ar: 'التنقل الرئيسي للمدونة'
  },
  NAV_HOME_ARIA: {
    fr: 'Menu Scan — Accueil',
    en: 'Menu Scan — Home',
    es: 'Menu Scan — Inicio',
    ar: 'Menu Scan — الصفحة الرئيسية'
  },
  NAV_BLOG: {
    fr: 'Blog',
    en: 'Blog',
    es: 'Blog',
    ar: 'المدونة'
  },
  FOOTER_BLOG: {
    fr: 'Blog',
    en: 'Blog',
    es: 'Blog',
    ar: 'المدونة'
  },
  FOOTER_CONTACT: {
    fr: 'Contact',
    en: 'Contact',
    es: 'Contacto',
    ar: 'اتصل بنا'
  },
  FOOTER_INSTAGRAM: {
    fr: 'Instagram',
    en: 'Instagram',
    es: 'Instagram',
    ar: 'إنستغرام'
  },
  FOOTER_COPYRIGHT: {
    fr: '© 2026 Menu Scan · Tous droits réservés. | Designed & Developed by ',
    en: '© 2026 Menu Scan · All rights reserved. | Designed & Developed by ',
    es: '© 2026 Menu Scan · Todos los derechos reservados. | Diseñado y desarrollado por ',
    ar: '© 2026 Menu Scan · جميع الحقوق محفوظة. | تصميم وتطوير '
  },
  FOOTER_CREDIT: {
    fr: 'AKKOUS',
    en: 'AKKOUS',
    es: 'AKKOUS',
    ar: 'AKKOUS'
  },
  TOC_HEADING: {
    fr: 'Sommaire',
    en: 'Table of contents',
    es: 'Tabla de contenidos',
    ar: 'جدول المحتويات'
  },
  PAGER_ARIA: {
    fr: 'Navigation entre articles',
    en: 'Article navigation',
    es: 'Navegación entre artículos',
    ar: 'التنقل بين المقالات'
  },
  TRANSLATIONS_ARIA: {
    fr: 'Traductions de cet article',
    en: 'Translations of this article',
    es: 'Traducciones de este artículo',
    ar: 'ترجمات هذه المقالة'
  },
  FAQ_HEADING: {
    fr: 'Questions fréquentes',
    en: 'Frequently asked questions',
    es: 'Preguntas frecuentes',
    ar: 'الأسئلة الشائعة'
  },
  RELATED_HEADING: {
    fr: 'Articles similaires',
    en: 'Related articles',
    es: 'Artículos relacionados',
    ar: 'مقالات ذات صلة'
  },
  PAGER_PREV_KIND: {
    fr: 'Article précédent',
    en: 'Previous article',
    es: 'Artículo anterior',
    ar: 'المقالة السابقة'
  },
  PAGER_NEXT_KIND: {
    fr: 'Article suivant',
    en: 'Next article',
    es: 'Artículo siguiente',
    ar: 'المقالة التالية'
  },
  CTA_TITLE: {
    fr: 'Votre menu digital, prêt en moins d’une heure',
    en: 'Your digital menu, ready in under an hour',
    es: 'Tu menú digital, listo en menos de una hora',
    ar: 'قائمتك الرقمية، جاهزة في أقل من ساعة'
  },
  CTA_TEXT: {
    fr: '500 DH, paiement unique, sans abonnement. Hébergement inclus, mise en place par notre équipe, 4 langues.',
    en: '500 MAD, one-time payment, no subscription. Hosting included, setup by our team, 4 languages.',
    es: '500 MAD, pago único, sin suscripción. Alojamiento incluido, instalación por nuestro equipo, 4 idiomas.',
    ar: '500 درهم، دفعة واحدة، بدون اشتراك. الاستضافة مشمولة، والتركيب من فريقنا، 4 لغات.'
  },
  CTA_PRIMARY: {
    fr: 'Commander sur WhatsApp',
    en: 'Order on WhatsApp',
    es: 'Pedir por WhatsApp',
    ar: 'اطلب عبر واتساب'
  },
  CTA_SECONDARY: {
    fr: 'Voir tous les articles',
    en: 'See all articles',
    es: 'Ver todos los artículos',
    ar: 'شاهد كل المقالات'
  }
};

/** Libellés_bruts (non échappés). La feuille Config peut les surcharger. */
function getLabels() {
  var raw = getConfigValue('LABELS');
  var parsed = parseJsonSafe(raw);
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : LABELS;
}

/**
 * Libellé d'interface BRUT pour `key` dans `lang`.
 * L'échappement est fait au point d'insertion (substitution du gabarit), jamais
 * ici puis à nouveau après.
 *
 * @param {string} key une clé de LABELS
 * @param {string} lang fr|en|es|ar
 * @return {string} texte brut, '' si la clé est inconnue
 */
function getLabelRaw(key, lang) {
  var all = getLabels();
  var entry = Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  if (!entry || typeof entry !== 'object') return '';
  var text = Object.prototype.hasOwnProperty.call(entry, lang) ? entry[lang] : entry[APP.DEFAULT_LANG];
  return text ? String(text) : '';
}

/**
 * Libellé d'interface pour `key` dans `lang`, déjà échappé pour le HTML.
 *
 * @param {string} key une clé de LABELS
 * @param {string} lang fr|en|es|ar
 * @return {string} texte échappé, '' si la clé est inconnue
 */
function getLabel(key, lang) {
  return escHtml(getLabelRaw(key, lang));
}

/** Libellé localisé d'une catégorie, BRUT. '' si la catégorie est inconnue. */
function getCategoryLabelRaw(slug, lang) {
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, slug)) return '';
  var entry = CATEGORY_LABELS[slug];
  var text = Object.prototype.hasOwnProperty.call(entry, lang) ? entry[lang] : entry[APP.DEFAULT_LANG];
  return text ? String(text) : '';
}

/** Libellé localisé d'une catégorie (échappé). '' si la catégorie est inconnue. */
function getCategoryLabel(slug, lang) {
  return escHtml(getCategoryLabelRaw(slug, lang));
}

/**
 * Locales Open Graph par langue : og:locale.
 * Le Maroc sert de référence (`fr_MA`) ; `ar_MA` accompagne `fr_MA` pour les
 * deux langues officielles du pays. `x-default` n'est pas une langue : il est
 * produit par le moteur à partir de hreflang, jamais par cette table.
 */
var OG_LOCALES = {
  fr: 'fr_MA',
  en: 'en_US',
  es: 'es_ES',
  ar: 'ar_MA'
};

/** Locale Open Graph d'une langue. Repli sur la locale de DEFAULT_LANG. */
function getOgLocale(lang) {
  return Object.prototype.hasOwnProperty.call(OG_LOCALES, lang)
    ? OG_LOCALES[lang]
    : OG_LOCALES[APP.DEFAULT_LANG];
}

/**
 * Correspondance slug → slug, lue dans la feuille Config (clé CATEGORY_MAP).
 * Format : JSON objet { "slug": "slug" }.
 *
 * Ne pas remplacer par un slugify() : la forme du slug est une décision
 * éditoriale. Toute clé ou valeur absente de CATEGORY_SLUGS est ignorée —
 * une feuille obsolète ne peut pas élargir le jeu de catégories.
 *
 * @return {Object} map slug → slug (jamais vide : repli sur CATEGORY_SLUGS)
 */
function getCategoryMap() {
  var fallback = {};
  CATEGORY_SLUGS.forEach(function (slug) { fallback[slug] = slug; });

  var parsed = parseJsonSafe(getConfigValue('CATEGORY_MAP'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

  var out = {};
  Object.keys(parsed).forEach(function (slug) {
    var key = String(slug).trim();
    var value = String(parsed[slug] === null ? '' : parsed[slug]).trim();
    if (CATEGORY_SLUGS.indexOf(key) === -1) return;
    if (CATEGORY_SLUGS.indexOf(value) === -1) return;
    out[key] = value;
  });
  // Une correspondance incomplète ou invalide ne doit pas effacer les
  // catégories de référence : on repart de zéro et on complète.
  CATEGORY_SLUGS.forEach(function (slug) {
    if (!Object.prototype.hasOwnProperty.call(out, slug)) out[slug] = slug;
  });
  return out;
}

/**
 * Résout un slug de catégorie.
 *
 * @param {string} slug slug de la feuille Articles
 * @param {string} [lang] langue du libellé affiché
 * @return {{slug:string, label:string}} label échappé, dans `lang`
 * @throws {Error} catégorie absente ou inconnue — jamais de création auto
 */
function resolveCategory(slug, lang) {
  var key = String(slug === null || slug === undefined ? '' : slug).trim();
  if (!key) throw new Error('Catégorie absente');
  var map = getCategoryMap();
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    throw new Error(
      'Catégorie inconnue : « ' + key + ' » (catégories attendues : ' +
      CATEGORY_SLUGS.join(', ') + ' — aucune création automatique)'
    );
  }
  return { slug: map[key], label: getCategoryLabel(map[key], lang) };
}

function isKnownCategory(slug) {
  return CATEGORY_SLUGS.indexOf(String(slug === null ? '' : slug).trim()) !== -1;
}

/** Liste triée des slugs de catégories connus, pour l'UI et le menu déroulant. */
function listKnownCategories() {
  return CATEGORY_SLUGS.slice().sort();
}

/**
 * Hôtes autorisés pour une image EXTERNE (clé Config IMAGE_ALLOWED_HOSTS,
 * format JSON : ["exemple.com", "cdn.exemple.com"]).
 *
 * Défaut vide = AUCUN hôte externe autorisé : seules les images déposées dans
 * /blog/images/ sont acceptées. Format invalide = liste vide (fail-closed),
 * jamais de liste ouverte par erreur de saisie.
 *
 * @return {string[]} hôtes en minuscules
 */
function getImageAllowedHosts() {
  var parsed = parseJsonSafe(getConfigValue('IMAGE_ALLOWED_HOSTS'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed)) return [];
  var out = [];
  parsed.forEach(function (host) {
    var h = String(host === null ? '' : host).trim().toLowerCase();
    if (h && out.indexOf(h) === -1) out.push(h);
  });
  return out;
}
