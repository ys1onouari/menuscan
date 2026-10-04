/* ==========================================================================
 * Menu Scan — Blog
 * --------------------------------------------------------------------------
 * Moteur du hub `/blog/`.
 *
 * Contraintes (voir AGENTS.md, section « Blog ») :
 *   - ZÉRO dépendance : pas d'i18next ici. Les pages du blog sont statiques et
 *     hors bundle Vite ; la langue et les libellés sont donc résolus localement.
 *   - Filtrage STRICT : `article.lang === langueActive`. Aucun repli. Un
 *     visiteur en anglais ne voit JAMAIS un article français.
 *   - Tri déTERMINISTE : date décroissante, puis slug croissant. Deux articles
 *     publiés le même jour ne peuvent pas changer d'ordre d'un rendu à l'autre.
 *   - Les pages d'article ne chargent PAS ce module : leur langue est portée
 *     par leur dossier (`/blog/{lang}/`) et leur `dir` est statique.
 * ========================================================================== */

(function () {
  'use strict';

  var LANGS = ['fr', 'en', 'es', 'ar'];
  var DEFAULT_LANG = 'fr';
  var STORAGE_KEY = 'i18nextLng';
  var DATA_URL = '/blog/articles.json';

  /* ---------------------------------------------------------------------- */
  /* Libellés (hub)                                                          */
  /* ---------------------------------------------------------------------- */

  var CATEGORY_LABELS = {
    'menu-digital': { fr: 'Menu digital', en: 'Digital menu', es: 'Menú digital', ar: 'قائمة رقمية' },
    'qr-code': { fr: 'QR Code', en: 'QR Code', es: 'Código QR', ar: 'رمز QR' },
    'restaurants-cafes': { fr: 'Restaurants & cafés', en: 'Restaurants & cafés', es: 'Restaurantes y cafés', ar: 'مطاعم ومقاهي' },
    'hotels-riads': { fr: 'Hôtels & riads', en: 'Hotels & riads', es: 'Hoteles y riads', ar: 'فنادق ورياض' },
    'commerces': { fr: 'Commerces', en: 'Retail', es: 'Comercios', ar: 'محلات تجارية' },
    'guides-prix': { fr: 'Guides & prix', en: 'Guides & pricing', es: 'Guías y precios', ar: 'أدلة وأسعار' }
  };

  /* Les 6 catégories, dans l'ordre du site. Un slug absent de cette liste
     n'est jamais rendu : le filtre est strict dans les deux sens. */
  var CATEGORY_ORDER = [
    'menu-digital',
    'qr-code',
    'restaurants-cafes',
    'hotels-riads',
    'commerces',
    'guides-prix'
  ];

  var UI = {
    all: { fr: 'Tous', en: 'All', es: 'Todos', ar: 'الكل' },
    count: {
      fr: function (n) { return n + (n > 1 ? ' articles' : ' article'); },
      en: function (n) { return n + (n > 1 ? ' articles' : ' article'); },
      es: function (n) { return n + ' artículos'; },
      ar: function (n) { return n + ' مقالات'; }
    },
    empty: {
      fr: 'Aucun article publié dans cette langue pour le moment.',
      en: 'No article published in this language yet.',
      es: 'Todavía no hay artículos publicados en este idioma.',
      ar: 'لم تُنشر أي مقالات بهذه اللغة بعد.'
    },
    error: {
      fr: 'Impossible de charger les articles. Réessayez plus tard.',
      en: 'Could not load articles. Please try again later.',
      es: 'No se pudieron cargar los artículos. Inténtalo más tarde.',
      ar: 'تعذّر تحميل المقالات. حاول مرة أخرى لاحقًا.'
    },
    switcherAria: {
      fr: 'Choisir la langue du blog',
      en: 'Choose the blog language',
      es: 'Elegir el idioma del blog',
      ar: 'اختر لغة المدونة'
    },
    filtersAria: {
      fr: 'Filtrer les articles par catégorie',
      en: 'Filter articles by category',
      es: 'Filtrar artículos por categoría',
      ar: 'تصفية المقالات حسب الفئة'
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Dates — tables de mois, PAS de Intl                                     */
  /* ---------------------------------------------------------------------- */

  /* Chiffres occidentaux (0-9) pour les 4 langues : cohérent avec le reste du
     site, qui n'emploie pas les chiffres arabo-indiens. */
  var MONTHS = {
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'ماي', 'يونيو', 'يوليوز', 'غشت', 'شتنبر', 'أكتوبر', 'نونبر', 'دجنبر']
  };

  /**
   * Formate une date ISO `YYYY-MM-DD` dans la langue demandée.
   * @return {string} chaîne vide si la date est illisible
   */
  function formatDate(iso, lang) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return '';
    var month = MONTHS[lang] || MONTHS[DEFAULT_LANG];
    var name = month[parseInt(m[2], 10) - 1];
    if (!name) return '';
    var day = String(parseInt(m[3], 10));
    var year = m[1];
    return lang === 'fr' ? day + ' ' + name + ' ' + year : name + ' ' + day + ', ' + year;
  }

  /* ---------------------------------------------------------------------- */
  /* Langue active                                                            */
  /* ---------------------------------------------------------------------- */

  /** Langue forcée par l'URL : `/blog/index.html?lang=ar`. Utilisée par le
      sélecteur de langue des articles quand une traduction n'existe pas —
      le hub doit alors s'ouvrir dans la langue demandée, pas dans celle du
      visiteur. Renvoie `null` si le paramètre est absent ou invalide. */
  function langFromQuery() {
    var raw;
    try {
      raw = new URLSearchParams(window.location.search).get('lang');
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    var tag = String(raw).toLowerCase();
    if (LANGS.indexOf(tag) === -1) return null;
    return tag;
  }

  /** Même chaîne de détection que `src/scripts/i18n.js`, plus `?lang=` en tête :
      URL → localStorage (`i18nextLng`) → navigateur → `fr`. */
  function detectLang() {
    var forced = langFromQuery();
    if (forced) return forced;

    var stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      stored = null;
    }
    if (stored && LANGS.indexOf(stored) !== -1) return stored;

    var candidates = [];
    if (navigator.languages && navigator.languages.length) {
      candidates = Array.prototype.slice.call(navigator.languages);
    }
    candidates.push(navigator.language);

    for (var i = 0; i < candidates.length; i++) {
      var tag = String(candidates[i] || '').toLowerCase();
      if (LANGS.indexOf(tag) !== -1) return tag;
      var base = tag.split('-')[0];
      if (LANGS.indexOf(base) !== -1) return base;
    }
    return DEFAULT_LANG;
  }

  function t(dict, lang) {
    return dict[lang] || dict[DEFAULT_LANG];
  }

  /* ---------------------------------------------------------------------- */
  /* Coquille du hub                                                          */
  /* ---------------------------------------------------------------------- */

/* Même convention d'attributs que le site principal : `data-i18n` (texte),
     `data-i18n-html` (notre propre markup statique), `data-i18n-aria-label`.
     Les clés sont namespacées « blog.… », comme sur le site principal. */
  var SHELL = {
    blog: {
      navAria: {
        fr: 'Navigation principale du blog',
        en: 'Blog main navigation',
        es: 'Navegación principal del blog',
        ar: 'التنقل الرئيسي للمدونة'
      },
      homeAria: {
        fr: 'Menu Scan — Accueil',
        en: 'Menu Scan — Home',
        es: 'Menu Scan — Inicio',
        ar: 'Menu Scan — الصفحة الرئيسية'
      },
      title: {
        fr: 'Blog Menu Scan',
        en: 'MenuScan Blog',
        es: 'Blog de Menu Scan',
        ar: 'مدونة مينو سكان'
      },
      tagline: {
        fr: 'Menu digital QR Code pour restaurants, cafés, hôtels et commerces au Maroc : conseils pratiques, guides et prix. 500 DH, paiement unique, sans abonnement.',
        en: 'Digital QR Code menus for restaurants, cafés, hotels and shops in Morocco: practical tips, guides and pricing. 500 MAD, one-time payment, no subscription.',
        es: 'Menús digitales con código QR para restaurantes, cafeterías, hoteles y comercios en Marruecos: consejos prácticos, guías y precios. 500 MAD, pago único, sin suscripción.',
        ar: 'قوائم رقمية برمز QR للمطاعم والمقاهي والفنادق والمتاجر في المغرب: نصائح عملية وأدلة وأسعار. 500 درهم، دفعة واحدة، بدون اشتراك.'
      },
      noscript: {
        fr: 'JavaScript est nécessaire pour afficher la liste des articles. Vous pouvez nous écrire sur WhatsApp : <a href="https://wa.me/212630230803" rel="noopener">+212 6 30 23 08 03</a>.',
        en: 'JavaScript is required to display the article list. You can message us on WhatsApp: <a href="https://wa.me/212630230803" rel="noopener">+212 6 30 23 08 03</a>.',
        es: 'Se necesita JavaScript para mostrar la lista de artículos. Puedes escribirnos por WhatsApp: <a href="https://wa.me/212630230803" rel="noopener">+212 6 30 23 08 03</a>.',
        ar: 'يلزم تفعيل JavaScript لعرض قائمة المقالات. يمكنك مراسلتنا على واتساب: <a href="https://wa.me/212630230803" rel="noopener">+212 6 30 23 08 03</a>.'
      },
      back: {
        fr: '← Retour à l’accueil',
        en: '← Back to home',
        es: '← Volver al inicio',
        ar: '← العودة إلى الصفحة الرئيسية'
      },
      footAria: {
        fr: 'Liens de pied de page',
        en: 'Footer links',
        es: 'Enlaces del pie de página',
        ar: 'روابط التذييل'
      },
      home: { fr: 'Accueil', en: 'Home', es: 'Inicio', ar: 'الصفحة الرئيسية' },
      contact: { fr: 'Contact', en: 'Contact', es: 'Contacto', ar: 'اتصل بنا' }
    },

    footer: {
      blog: {
        fr: 'Blog',
        en: 'Blog',
        es: 'Blog',
        ar: 'المدونة',
      },
      contact: {
        fr: 'Contact',
        en: 'Contact',
        es: 'Contacto',
        ar: 'اتصل بنا',
      },
      instagram: {
        fr: 'Instagram',
        en: 'Instagram',
        es: 'Instagram',
        ar: 'إنستغرام',
      },
      copyright: {
        fr: '© 2026 Menu Scan · Tous droits réservés. | Designed & Developed by ',
        en: '© 2026 Menu Scan · All rights reserved. | Designed & Developed by ',
        es: '© 2026 Menu Scan · Todos los derechos reservados. | Diseñado y desarrollado por ',
        ar: '© 2026 Menu Scan · جميع الحقوق محفوظة. | تصميم وتطوير ',
      },
      copyrightLinkText: {
        fr: 'AKKOUS',
        en: 'AKKOUS',
        es: 'AKKOUS',
        ar: 'AKKOUS',
      },
      waMessage: {
        fr: 'Bonjour! Je souhaite commander Menu Scan (menu digital QR Code) à 500 DH.',
        en: 'Hello! I’d like to order Menu Scan (digital QR Code menu) for 500 MAD.',
        es: '¡Hola! Me gustaría solicitar Menu Scan (menú digital con código QR) por 500 MAD.',
        ar: 'مرحبًا! أود طلب Menu Scan (قائمة رقمية برمز QR) بسعر 500 درهم.',
      }
    }
  };

  /** Résout une clé namespacée « blog.… » ou « footer.… » ; renvoie undefined si elle est inconnue. */
  function shell(key, lang) {
    var ns = key.slice(0, key.indexOf('.'));
    var name = key.slice(key.indexOf('.') + 1);
    if (!SHELL[ns] || !SHELL[ns][name]) return undefined;
    return t(SHELL[ns][name], lang);
  }

  function applyShell(lang) {
    var texts = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < texts.length; i++) {
      var value = shell(texts[i].getAttribute('data-i18n'), lang);
      if (value !== undefined) texts[i].textContent = value;
    }
    var htmls = document.querySelectorAll('[data-i18n-html]');
    for (var h = 0; h < htmls.length; h++) {
      var html = shell(htmls[h].getAttribute('data-i18n-html'), lang);
      if (html !== undefined) htmls[h].innerHTML = html;
    }
    var labels = document.querySelectorAll('[data-i18n-aria-label]');
    for (var a = 0; a < labels.length; a++) {
      var label = shell(labels[a].getAttribute('data-i18n-aria-label'), lang);
      if (label !== undefined) labels[a].setAttribute('aria-label', label);
    }

    /* Même algorithme que updateWhatsAppLinks() de src/scripts/i18n.js : le
       message pré-rempli est ajouté à tous les liens wa.me. */
    var waMsg = encodeURIComponent(t(SHELL.footer.waMessage, lang));
    var waLinks = document.querySelectorAll('a[href^="https://wa.me/"]');
    for (var w = 0; w < waLinks.length; w++) {
      var waHref = waLinks[w].getAttribute('href');
      if (!waHref) continue;
      var waNum = waHref.match(/wa\.me\/(\d+)/);
      waLinks[w].setAttribute('href', 'https://wa.me/' + (waNum ? waNum[1] : '212630230803') + (waMsg ? '?text=' + waMsg : ''));
    }
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------------------------------- */
  /* Données                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Ne conserve que les entrées exploitables. Toute entrée incomplète est ignorée. */
  function sanitize(entries) {
    if (!Array.isArray(entries)) return [];
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var a = entries[i] || {};
      if (!a.lang || LANGS.indexOf(a.lang) === -1) continue;
      if (!a.slug || !a.url || !a.title) continue;
      if (CATEGORY_ORDER.indexOf(a.category) === -1) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''))) continue;
      out.push(a);
    }
    return out;
  }

  /** Date décroissante, puis slug croissant : l'ordre ne dépend jamais du JSON. */
  function sortArticles(list) {
    return list.slice().sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? 1 : -1;
      return String(x.slug) < String(y.slug) ? -1 : 1;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Rendu                                                                    */
  /* ---------------------------------------------------------------------- */

  function renderCard(article, lang) {
    var meta = [];
    var date = formatDate(article.date, lang);
    if (date) meta.push(esc(date));
    if (article.readingTime) meta.push(esc(article.readingTime) + '&nbsp;min');
    var metaHtml = meta.length ? '<div class="b-meta">' + meta.join('<span class="b-meta-sep">·</span>') + '</div>' : '';

    var img = '';
    if (article.image) {
      img = '<div class="b-card-img"><img src="' + esc(article.image) + '" alt="' +
        esc(article.imageAlt || '') + '" width="' + esc(article.imageWidth || 1200) +
        '" height="' + esc(article.imageHeight || 675) + '" loading="lazy" decoding="async"></div>';
    }

    return '<li class="b-card">' + img +
      '<div class="b-card-body">' +
      '<div class="b-card-cat">' + esc(t(CATEGORY_LABELS[article.category], lang)) + '</div>' +
      '<h2><a href="' + esc(article.url) + '">' + esc(article.title) + '</a></h2>' +
      (article.excerpt ? '<p>' + esc(article.excerpt) + '</p>' : '') +
      metaHtml +
      '</div></li>';
  }

  function render(articles, lang, category) {
    var listEl = document.getElementById('b-list');
    var countEl = document.getElementById('b-count');
    var filtersEl = document.getElementById('b-filters');
    if (!listEl || !countEl || !filtersEl) return;

    /* Langue : filtre STRICT, appliqué à chaque rendu. Aucun repli — un
       visiteur en arabe ne voit JAMAIS l'article français, même si articles.json
       ne contient aucune ligne `ar`. */
    var forLang = articles.filter(function (a) {
      return a.lang === lang;
    });

    /* Filtres : « Tous » + les catégories qui ont au moins un article dans la
       langue active. Une catégorie vide ne propose rien à filtrer. */
    var present = [];
    CATEGORY_ORDER.forEach(function (slug) {
      for (var i = 0; i < forLang.length; i++) {
        if (forLang[i].category === slug) { present.push(slug); break; }
      }
    });

    var chips = ['<button type="button" class="b-filter" data-cat="" aria-pressed="' +
      (category ? 'false' : 'true') + '">' + esc(t(UI.all, lang)) + '</button>'];
    present.forEach(function (slug) {
      chips.push('<button type="button" class="b-filter" data-cat="' + esc(slug) + '" aria-pressed="' +
        (category === slug ? 'true' : 'false') + '">' + esc(t(CATEGORY_LABELS[slug], lang)) + '</button>');
    });
    filtersEl.innerHTML = chips.join('');

    var visible = forLang.filter(function (a) {
      return !category || a.category === category;
    });

    countEl.textContent = UI.count[lang] ? UI.count[lang](visible.length) : String(visible.length);

    if (!visible.length) {
      listEl.innerHTML = '';
      var empty = document.createElement('li');
      empty.className = 'b-empty';
      empty.textContent = t(UI.empty, lang);
      listEl.appendChild(empty);
      return;
    }

    listEl.innerHTML = visible.map(function (a) { return renderCard(a, lang); }).join('');
  }

  /* ---------------------------------------------------------------------- */
  /* Amorçage                                                                 */
  /* ---------------------------------------------------------------------- */

  function boot() {
    var lang = detectLang();
    var state = sanitize([]);
    var category = '';

    /* `?lang=` est une demande explicite : on l'enregistre sous la même clé que
       le site (`i18nextLng`) pour que la langue survive à la navigation — sans
       cela le hub reviendrait à la langue du navigateur au rechargement. */
    if (langFromQuery()) {
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch (e) {
        /* stockage indisponible : le blog reste utilisable */
      }
    }

    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    applyShell(lang);

    var switcher = document.getElementById('b-lang');
    if (switcher) {
      switcher.setAttribute('aria-label', t(UI.switcherAria, lang));
      switcher.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-lang]');
        if (!btn) return;
        var next = btn.getAttribute('data-lang');
        if (LANGS.indexOf(next) === -1 || next === lang) return;
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch (e) {
          /* stockage indisponible : le blog reste utilisable */
        }
        lang = next;
        /* Changer de langue repart de zéro : la catégorie active peut ne pas
           exister dans la langue cible, et le filtre ne doit jamais être conservé
           dans un état qui n'a plus de sens. */
        category = '';
        document.documentElement.lang = next;
        document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
        applyShell(next);
        switcher.setAttribute('aria-label', t(UI.switcherAria, next));
        switcher.querySelectorAll('[data-lang]').forEach(function (el) {
          el.setAttribute('aria-pressed', el === btn ? 'true' : 'false');
        });
        render(state, lang, category);
      });
      switcher.querySelectorAll('[data-lang]').forEach(function (el) {
        el.setAttribute('aria-pressed', el.getAttribute('data-lang') === lang ? 'true' : 'false');
      });
    }

    var filters = document.getElementById('b-filters');
    if (filters) filters.setAttribute('aria-label', t(UI.filtersAria, lang));

    fetch(DATA_URL, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        state = sortArticles(sanitize(data && data.articles));
        render(state, lang, category);
      })
      .catch(function () {
        var countEl = document.getElementById('b-count');
        var listEl = document.getElementById('b-list');
        if (countEl) countEl.textContent = '';
        if (listEl) {
          listEl.innerHTML = '<li class="b-error">' + esc(t(UI.error, lang)) + '</li>';
        }
      });

    if (filters) {
      filters.addEventListener('click', function (event) {
        var btn = event.target.closest('.b-filter');
        if (!btn) return;
        category = btn.getAttribute('data-cat') || '';
        filters.querySelectorAll('.b-filter').forEach(function (el) {
          el.setAttribute('aria-pressed', el === btn ? 'true' : 'false');
        });
        render(state, lang, category);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();