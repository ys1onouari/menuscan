# Audit SEO — Menu Scan

> Document généré le 2025-06-20  
> Projet : `menu-scan/` — Landing page statique Vite (HTML, CSS, Vanilla JS)  
> Domaine cible : `https://menuscan.space/`

---

## 1. Vue d'ensemble

### Philosophie SEO du projet

Le SEO est traité comme une priorité native : les balises critiques (`title`, `description`, `og:`, `twitter:`) sont codées en dur dans le HTML initial puis dynamiquement mises à jour côté client via `i18next` lors du changement de langue. Le projet suit une philosophie **"SEO-first dans le HTML, i18n en surcouche"** : le fichier `index.html` contient déjà des balises françaises complètes (pas de placeholders vides), garantissant une indexation correcte même si JavaScript échoue.

### Architecture générale

```
index.html                  ← Point d'entrée unique (SPA-like, page unique)
├── <head>                  ← Balises SEO statiques + JSON-LD
├── <body>
│   ├── <header#loader>     ← Loader initial (retiré après 2.5s)
│   ├── <nav#navbar>        ← Navigation fixe
│   ├── <main>
│   │   ├── <section#hero>  ← Hero + phone mockup
│   │   └── <section#details> ← Features, pricing, FAQ
│   └── <footer>
└── /src/scripts/main.js    ← Initialise 11 modules (DOMContentLoaded)
```

### Objectifs SEO

| Objectif | Statut |
|---|---|
| Indexation rapide de la page unique | ✅ Atteint (HTML complet au chargement) |
| Visibilité sur recherche locale Maroc | ✅ `Maroc` dans title, description, JSON-LD |
| Multilingue indexable | ✅ hreflang + meta traduites dynamiquement |
| Rich snippets (FAQ, Product) | ✅ JSON-LD FAQPage + Product |
| Performance mobile | ✅ Vite build, CSS minifié, pas de framework lourd |

---

## 2. URLs

### Structure des URLs

L'application est une **page unique** (single-page landing). Aucune route dynamique côté serveur.

| URL | Rôle | Présent dans |
|---|---|---|
| `https://menuscan.space/` | Page d'accueil (français par défaut) | Canonical, hreflang, sitemap |
| `https://menuscan.space/en/` | Version anglaise (hreflang uniquement) | Hreflang link |
| `https://menuscan.space/es/` | Version espagnole (hreflang uniquement) | Hreflang link |
| `https://menuscan.space/ar/` | Version arabe (hreflang uniquement) | Hreflang link |

**⚠️ Les URLs `/en/`, `/es/`, `/ar/` sont déclarées dans les hreflangs et le sitemap, mais n'existent pas physiquement.** Aucune redirection ou page dédiée n'est servie pour ces chemins. Google pourrait les explorer et obtenir une 404, ce qui dilue la signalétique hreflang.

### Gestion des slugs

Aucun slug n'est utilisé. Il n'y a pas de pages de contenu secondaires (blog, catalogue, etc.).

### URLs dynamiques

Absence d'URLs dynamiques. Toute la logique de changement de langue est purement côté client (`i18next.changeLanguage()`). L'URL ne change pas lors du changement de langue (pas de `history.pushState` ni de paramètre `?lng=`).

### Canonical URLs

Déclarée dans `index.html` ligne 10 :

```html
<link rel="canonical" href="https://menuscan.space/">
```

**Avantage** : Évite la duplication de contenu si le site est accessible via plusieurs domaines/IPs.  
**Limite** : Non mise à jour dynamiquement en fonction de la langue sélectionnée.

### Redirections éventuelles

Aucune redirection configurée. Pas de fichier `_redirects` (Vercel), `.htaccess`, ou `vercel.json` avec règles de redirection. Les URLs `/en/`, `/es/`, `/ar/` ne sont pas redirigées vers la racine.

---

## 3. Meta Tags

### Liste exhaustive des balises

| Balise | Valeur (français par défaut) | Source |
|---|---|---|
| `title` | `Menu Scan — Menu Digital QR Code sans abonnement (500 DH à vie) \| Maroc` | `index.html:7` + i18n dynamic |
| `meta name="description"` | `Menu digital avec QR Code personnalisé pour restaurant et commerce au Maroc. Commandes WhatsApp, dashboard, 4 langues. Paiement unique de 500 DH, sans abonnement. Prêt en moins d'une heure.` | `index.html:8` + i18n dynamic |
| `meta name="robots"` | `index, follow, max-snippet:-1, max-image-preview:large` | `index.html:9` (statique) |
| `meta name="viewport"` | `width=device-width, initial-scale=1.0` | `index.html:5` (statique) |
| `meta charset` | `UTF-8` | `index.html:4` (statique) |

### Où et comment elles sont générées

**Génération initiale** (fichier `index.html`) :

Les balises `title` et `meta description` sont écrites en dur en français. C'est intentionnel : le HTML statique est complet pour les crawlers avant exécution JS.

**Mise à jour dynamique** (fichier `src/scripts/i18n.js`, fonctions `translatePage()` et `applyLanguage()`) :

```javascript
// i18n.js:97-101
const titleEl = document.querySelector('title');
if (titleEl) titleEl.textContent = t('meta.title');

const metaDesc = document.querySelector('meta[name="description"]');
if (metaDesc) metaDesc.setAttribute('content', t('meta.description'));
```

Les valeurs sont chargées depuis les fichiers de locale :
- `src/locales/fr.js` → `meta.title`, `meta.description`
- `src/locales/en.js` → mêmes clés, valeurs anglaises
- `src/locales/es.js` → valeurs espagnoles
- `src/locales/ar.js` → valeurs arabes

**⚠️ Problème** : Google indexe principalement le HTML initial. Les meta tags dynamiques mises à jour par JS ne sont pas toujours prises en compte. Le HTML statique étant en français, seules les versions françaises sont garanties indexées.

### Balises non utilisées

| Balise | Présente ? | Raison |
|---|---|---|
| `meta name="keywords"` | ❌ | Google ignore cette balise, bonne pratique de l'omettre |
| `meta name="author"` | ❌ | Non critique pour le SEO |
| `meta name="revisit-after"` | ❌ | Ignorée par les moteurs modernes |

---

## 4. Open Graph

### Configuration complète

Déclarée dans `index.html:13-22` :

```html
<meta property="og:type" content="website">
<meta property="og:locale" content="fr_MA">
<meta property="og:site_name" content="Menu Scan">
<meta property="og:title" content="Menu Scan — Menu Digital QR Code sans abonnement (500 DH à vie)">
<meta property="og:description" content="Menu digital avec QR Code personnalisé pour restaurant et commerce au Maroc. Paiement unique de 500 DH, sans abonnement.">
<meta property="og:url" content="https://menuscan.space/">
<meta property="og:image" content="https://menuscan.space/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Menu Scan — Menu digital QR Code pour restaurants">
```

### Détails

| Champ | Valeur initiale | Dynamique ? |
|---|---|---|
| `og:title` | FR statique | ✅ Mise à jour via `t('meta.ogTitle')` dans `i18n.js:103-104` |
| `og:description` | FR statique | ✅ Mise à jour via `t('meta.ogDescription')` dans `i18n.js:106-107` |
| `og:image` | `https://menuscan.space/og-image.jpg` | ❌ Statique (identique pour toutes langues) |
| `og:image:alt` | FR statique | ✅ Mise à jour via `t('meta.ogImgAlt')` dans `i18n.js:109-110` |
| `og:url` | `https://menuscan.space/` | ❌ Statique |
| `og:type` | `website` | ❌ Statique |
| `og:locale` | `fr_MA` | ❌ Non mis à jour lors du changement de langue |
| `og:site_name` | `Menu Scan` | ❌ Statique |

### Points d'attention

- `og:locale` reste `fr_MA` même en anglais/espagnol/arabe. Google et Facebook lisent cette balise pour déterminer la langue. Une page en arabe avec `og:locale=fr_MA` envoie un signal contradictoire.
- `og:image` pointe vers `/og-image.jpg`. Ce fichier n'existe pas dans le dépôt (ni dans `/public/`). Les crawlers obtiendront une erreur 404 lors du partage social.

---

## 5. Twitter Cards

### Configuration complète

Déclarée dans `index.html:25-28` :

```html
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Menu Scan — Menu Digital QR Code sans abonnement (500 DH à vie)">
<meta name="twitter:description" content="Menu digital avec QR Code personnalisé pour restaurant et commerce au Maroc. Paiement unique de 500 DH, sans abonnement.">
<meta name="twitter:image" content="https://menuscan.space/og-image.jpg">
```

### Détails

| Champ | Valeur initiale | Dynamique ? |
|---|---|---|
| `twitter:card` | `summary_large_image` | ❌ Statique |
| `twitter:title` | FR statique | ✅ Mise à jour via `t('meta.twitterTitle')` dans `i18n.js:112-113` |
| `twitter:description` | FR statique | ✅ Mise à jour via `t('meta.twitterDescription')` dans `i18n.js:115-116` |
| `twitter:image` | `https://menuscan.space/og-image.jpg` | ❌ Statique (même problème que OG) |

### Points d'attention

- `twitter:image` partage le même fichier inexistant que `og:image`.
- `twitter:site` et `twitter:creator` ne sont pas définis (pas de handle Twitter).

---

## 6. Données structurées

### Liste complète des schémas utilisés

Les données structurées sont injectées en JSON-LD dans `index.html:59-159`.

#### 6.1 Organization

```json
{
  "@type": "Organization",
  "@id": "https://menuscan.space/#organization",
  "name": "Menu Scan",
  "url": "https://menuscan.space",
  "logo": "https://menuscan.space/og-image.jpg",
  "description": "Service de menu digital QR Code...",
  "contactPoint": {
    "@type": "ContactPoint",
    "telephone": "+212-XXX-XXXXXX",
    "contactType": "customer service",
    "availableLanguage": ["French", "English", "Spanish", "Arabic"]
  },
  "sameAs": ["https://instagram.com/menuscan"],
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "Casablanca",
    "addressCountry": "MA"
  }
}
```

**Problèmes identifiés :**
- `telephone` contient `+212-XXX-XXXXXX` — un placeholder, pas un vrai numéro. Google peut pénaliser les données structurées invalides.
- `logo` pointe vers `/og-image.jpg` (fichier inexistant).
- `sameAs` ne contient que Instagram. Pas de Google Business Profile, Facebook, LinkedIn.

#### 6.2 Product

```json
{
  "@type": "Product",
  "@id": "https://menuscan.space/#product",
  "name": "Menu Scan — Menu Digital QR Code",
  "description": "Menu digital avec QR Code personnalisé...",
  "url": "https://menuscan.space",
  "image": "https://menuscan.space/og-image.jpg",
  "brand": { "@type": "Brand", "name": "Menu Scan" },
  "category": "Digital Menu / QR Code",
  "offers": {
    "@type": "Offer",
    "price": "500",
    "priceCurrency": "MAD",
    "priceValidUntil": "2027-12-31",
    "availability": "https://schema.org/InStock",
    "url": "https://menuscan.space"
  }
}
```

**Points forts :**
- `priceCurrency` correctement défini sur `MAD` (dirham marocain).
- `availability: InStock` correct.
- `priceValidUntil` défini.

**Problèmes :**
- `image` pointe vers `/og-image.jpg` (inexistant).
- `brand` n'a pas de `@id` ou `url` spécifique.

#### 6.3 FAQPage

```json
{
  "@type": "FAQPage",
  "@id": "https://menuscan.space/#faq",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Pourquoi pas d'abonnement ?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "500 DH une seule fois..."
      }
    },
    // ... 4 autres questions
  ]
}
```

**Points forts :**
- 5 questions bien rédigées, ciblant les interrogations réelles des clients.
- Structure conforme aux guidelines Google pour les rich snippets FAQ.

**Problèmes :**
- Les questions/réponses sont en français uniquement dans le HTML statique. Pas de mise à jour dynamique via JS/i18n.
- Les microdonnées `itemscope` sont également présentes dans le HTML (double marquage). Ce n'est pas un problème en soi, mais il faut assurer la cohérence.

#### 6.4 Microdonnées HTML (itemscope)

En complément du JSON-LD FAQPage, les éléments FAQ utilisent aussi `itemscope` :

```html
<article class="faq-item reveal" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
  <div class="faq-q" role="button" tabindex="0" aria-expanded="false" itemprop="name">
    <span data-i18n="faq.0.q">Pourquoi pas d'abonnement ?</span>
    ...
  </div>
  <div class="faq-a" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <div itemprop="text" data-i18n="faq.0.a">500 DH une seule fois...</div>
  </div>
</article>
```

**Problème** : Les attributs `itemprop` sont placés sur les conteneurs (`.faq-q`, `.faq-a`), pas directement sur les éléments contenant le texte. Google peut avoir du mal à extraire les valeurs.

### Schémas absents

| Schéma | Utile pour | Recommandé |
|---|---|---|
| `LocalBusiness` | Visibilité locale "près de moi" | ⭐ Critique |
| `BreadcrumbList` | Navigation dans les SERP | Optionnel (page unique) |
| `WebSite` | SearchAction (search box) | Optionnel |

---

## 7. Sitemap

### Génération

Le sitemap est un fichier **manuel** (non généré dynamiquement) situé à :

```
public/sitemap.xml
```

Contenu complet :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>https://menuscan.space/</loc>
    <lastmod>2025-06-19</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="fr" href="https://menuscan.space/"/>
    <xhtml:link rel="alternate" hreflang="en" href="https://menuscan.space/en/"/>
    <xhtml:link rel="alternate" hreflang="es" href="https://menuscan.space/es/"/>
    <xhtml:link rel="alternate" hreflang="ar" href="https://menuscan.space/ar/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="https://menuscan.space/"/>
  </url>
</urlset>
```

### Contenu

- **1 seule URL** : `https://menuscan.space/`
- **Hreflang** : 5 variantes (fr, en, es, ar, x-default) en XHTML
- **Priorité** : `1.0` (maximale)
- **Fréquence** : `monthly`

### Exclusions

Aucune exclusion. Le sitemap ne contient qu'une seule URL.

### Fréquence de mise à jour

Le fichier est **statique**. La date `lastmod` doit être manuellement mise à jour lors des modifications.

### Points d'attention

- Les URLs `/en/`, `/es/`, `/ar/` sont dans le sitemap mais n'ont pas de page réelle → Google générera des erreurs 404.
- Pas de sitemap pour images ou vidéos (bien qu'une vidéo `demo.mp4` existe).
- Pas d'outil de génération automatique (sitemap dynamique ou build step).

---

## 8. robots.txt

### Contenu complet

```
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/

Sitemap: https://menuscan.space/sitemap.xml

User-agent: GPTBot
Allow: /
Crawl-delay: 2

User-agent: Google-Extended
Allow: /
Crawl-delay: 2

User-agent: Claude-Web
Allow: /
Crawl-delay: 2

User-agent: PerplexityBot
Allow: /
Crawl-delay: 2
```

### Analyse

| Règle | Explication |
|---|---|
| `Allow: /` | Tout le site est accessible aux crawlers |
| `Disallow: /admin/` | Bloque les crawlers des chemins admin (bonne pratique) |
| `Disallow: /api/` | Bloque les crawlers des endpoints API (bonne pratique) |
| `Sitemap` | Pointe vers le sitemap |
| `Crawl-delay: 2` | Limite la cadence des crawlers LLM à 2 secondes |

**Note** : Les chemins `/admin/` et `/api/` n'existent pas dans l'architecture actuelle. Les règles sont préventives.

**Manquant** : Aucune directive `noindex` ou `nofollow` n'est utilisée (cohérent : une seule page, tout est indexable).

---

## 9. Indexation

### Pages indexables

| Page | Indexable ? | Raison |
|---|---|---|
| `https://menuscan.space/` | ✅ Oui | `robots: index, follow`, pas de `noindex` |

### Pages non indexables

Aucune page n'est intentionnellement non indexable. Aucune utilisation de `<meta name="robots" content="noindex">` ou d'en-tête `X-Robots-Tag: noindex`.

### Utilisation de noindex/nofollow

- Pas de `noindex` ou `nofollow` sur la page principale.
- Les liens internes vers WhatsApp (`wa.me`) ne sont pas en `nofollow` (ce n'est pas nécessaire pour des liens externes légitimes).

### Points d'attention

- Google Discover et l'indexation mobile-first sont bien supportés (viewport correct, responsive design, mobile-first).
- La page est en plein contenu lors du premier rendu HTML (pas de skeleton/loading state visible par les crawlers).

---

## 10. Performance SEO

### Lazy loading

**Images** : Aucune image `<img>` n'est utilisée. Les icônes sont en SVG inline. La seule image est la vidéo `demo.mp4` chargée avec `preload="metadata"`.

```html
<video autoplay loop muted playsinline width="100%" preload="metadata">
  <source src="/assets/video/demo.mp4" type="video/mp4">
</video>
```

- `preload="metadata"` : bonne pratique, ne télécharge que les métadonnées de la vidéo au chargement initial.
- `muted` + `autoplay` : nécessaire pour le autoplay mobile, mais peut impacter Core Web Vitals si la vidéo est lourde.

**Autres éléments** : Les sections sont chargées en une fois (pas de lazy loading sur le contenu statique). Les modules JS sont chargés avec `type="module"` (differed par défaut).

### Optimisation des images

- **Aucune image raster** utilisée — uniquement des SVG inline et une vidéo.
- **SVG** : Tous les icônes sont en SVG inline dans le HTML (pas de requêtes HTTP supplémentaires). Exemple :

```html
<svg width="20" height="20" fill="none" stroke="white" viewBox="0 0 24 24" stroke-width="2.5" aria-hidden="true" focusable="false">...</svg>
```

- **Favicon** : SVG inline via data URI (pas de fichier favicon.io à charger).
- **Aucune perte d'optimisation** puisque pas d'images JPEG/PNG/WebP.

### Preload / Prefetch

**Configuré** :

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

- `preconnect` pour Google Fonts : réduit le temps de connexion.
- **Non configuré** : pas de `preload`, `prefetch`, `dns-prefetch`, ou `modulepreload` pour les ressources critiques (JS, CSS).

### Compression

- **CSS** : `cssMinify: true` dans `vite.config.js` → CSS minifié en production.
- **JS** : Vite minifie et treeshake automatiquement via Rollup.
- **HTML** : Vite ne minifie pas l'HTML par défaut (pas de `minifyHTML` configuré).

### Cache

- Aucun Service Worker configuré.
- Pas de stratégie de cache HTTP spécifiée (dépend du serveur/hébergement Vercel).
- `package-lock.json` présent → installation déterministe (bon pour CI/CD).

### Code splitting

- **Modules langues** : `en.js`, `es.js`, `ar.js` sont chargés dynamiquement avec `import()` — un chunk par langue.
- **French** : bundle statique inclus dans le bundle principal.
- Pas d'autre code splitting.

### Bundles production (Vite build)

```
index.html                  33.89 kB (6.92 kB gzipped)
assets/index-BJqz2pIc.css   27.36 kB (5.94 kB gzipped)
assets/en-CgoM0h0q.js        4.64 kB (1.84 kB gzipped)
assets/es-x9UmRd3w.js        5.11 kB (2.02 kB gzipped)
assets/ar-DQnw9vFu.js        6.33 kB (2.15 kB gzipped)
assets/index-wqNHKkUe.js    65.40 kB (21.61 kB gzipped)
```

Le bundle principal JS (`index-wqNHKkUe.js`) fait **65 kB** (22 kB gzipped) — très léger, excellent pour le SEO.

### Synthèse performance

| Critère | Évaluation |
|---|---|
| Taille bundle JS | ✅ Excellent (~22 kB gzipped) |
| Taille bundle CSS | ✅ Bon (~6 kB gzipped) |
| Images | ✅ Aucune image raster |
| Polices | ⚠️ Google Fonts = requête externe |
| Preload/Prefetch | ❌ Non configuré |
| Service Worker | ❌ Non configuré |
| Minification HTML | ❌ Non configurée (via Vite) |

---

## 11. Images

### Analyse exhaustive

| Ressource | Type | Balise alt | Dimensions | Loading | Format |
|---|---|---|---|---|---|
| Icônes UI (~30) | SVG inline | `aria-hidden="true"` | `20x24` via viewBox | Immédiat | SVG (inline) |
| Phone mockup icons | SVG inline | `aria-hidden="true"` | `20x24` via viewBox | Immédiat | SVG (inline) |
| Feature icons (8) | SVG inline | `aria-label` sur conteneur parent | `20x24` via viewBox | Immédiat | SVG (inline) |
| Video demo | MP4 | N/A (balise `<video>`) | 100% width | `preload="metadata"` | MP4 |
| Favicon | SVG data URI | N/A | 24x24 | Immédiat | SVG (inline) |
| OG Image | JPEG (référencé) | `og:image:alt` présent | 1200x630 | N/A (externe) | JPEG |

### Points forts

- Tous les SVG décoratifs ont `aria-hidden="true"` + `focusable="false"` — excellente pratique.
- `og:image:alt` est défini et traduit dynamiquement.
- `data-i18n-alt` présent dans la logique i18n pour traduire les attributs `alt` (bien qu'aucune image avec `alt` ne soit actuellement utilisée).

### Points faibles

- **`og:image` / `twitter:image`** pointent vers `/og-image.jpg` qui **n'existe pas** dans `/public/`.
- Aucune véritable image avec `alt` descriptif (toutes les icônes sont décoratives).
- La vidéo `demo.mp4` (dans `public/assets/video/`) pourrait bénéficier d'un poster image et de `<track>` pour les sous-titres.

---

## 12. Internationalisation

### Langues supportées

| Code | Langue | Direction | Type de chargement |
|---|---|---|---|
| `fr` | Français | LTR | Statique (bundled) |
| `en` | English | LTR | Dynamique (`import()`) |
| `es` | Español | LTR | Dynamique (`import()`) |
| `ar` | العربية | RTL | Dynamique (`import()`) |

### Hreflang

Déclaré dans `index.html:31-35` :

```html
<link rel="alternate" hreflang="fr" href="https://menuscan.space/">
<link rel="alternate" hreflang="en" href="https://menuscan.space/en/">
<link rel="alternate" hreflang="es" href="https://menuscan.space/es/">
<link rel="alternate" hreflang="ar" href="https://menuscan.space/ar/">
<link rel="alternate" hreflang="x-default" href="https://menuscan.space/">
```

Également présentes dans le sitemap avec la syntaxe XHTML.

### URLs multilingues

Les URLs `/en/`, `/es/`, `/ar/` sont déclarées mais inexistentes. Aucune redirection ou page distincte.

### Stratégie de traduction SEO

| Aspect | Mécanisme |
|---|---|
| Langue initiale | HTML `lang="fr"` (statique) |
| Détection auto | `localStorage` → `navigator.language` → `'fr'` |
| Mise à jour `<html lang>` | `i18n.js:70` : `document.documentElement.lang = lang` |
| Direction RTL | `i18n.js:71` : `document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'` |
| Meta title/description | Mis à jour dynamiquement via `translatePage()` |
| OG/Twitter meta | Mis à jour dynamiquement |
| Contenu texte | Attributs `data-i18n` |
| `og:locale` | **Non mis à jour** — reste `fr_MA` |
| Changement d'URL | **Pas de changement** — pas de `history.pushState` |

### Impact SEO

- **Positif** : hreflang correctement configuré, signaux multilingues envoyés.
- **Négatif** : Google indexe le HTML statique (français). Les versions en/ES/AR ne sont pas indexées car :
  1. Les URLs `/en/`, `/es/`, `/ar/` n'existent pas.
  2. Les meta tags dynamiques ne sont pas lues par Google.
- **Risque** : Google peut considérer les hreflangs comme invalides et les ignorer.

---

## 13. Accessibilité

### Structure des titres (H1/H2/H3)

```html
<h1>
  <span data-i18n="hero.title">Le menu digital</span>
  <span class="grad" data-i18n="hero.titleHighlight">sans abonnement.</span>
</h1>
<!-- Section #details -->
<h2 data-i18n="details.stepsTitle">Comment ça marche ?</h2>
  <!-- Steps -->
  <h3>Créez votre catalogue</h3>
  <h3>Partagez le QR Code</h3>
  <h3>Recevez les commandes</h3>
<!-- Demo section -->
<h3 class="demo-title">Voyez MenuScan en action</h3>
<!-- Features -->
<h3>QR Code unique</h3>
<h3>Commandes WhatsApp</h3>
<!-- ... -->
<!-- Pricing card -->
<h2>Menu Scan</h2>
```

**Hiérarchie** : ✅ `h1` → `h2` → `h3`. Pas de saut de niveau. Bonne structure.

### Aria-label

De nombreux éléments ont des `data-i18n-aria-label` traduits dynamiquement :

```html
<section id="hero" data-i18n-aria-label="hero.aria">
<nav id="navbar" data-i18n-aria-label="nav.aria">
<a href="/" class="logo" data-i18n-aria-label="nav.ariaHome">
<!-- etc. -->
```

La logique dans `i18n.js:93-95` met à jour tous les `data-i18n-aria-label` :

```javascript
document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
  el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
});
```

### Navigation clavier

- **FAQ** : Support Enter/Space (`faq.js`).
- **Lang switcher** : `role="radiogroup"` et `role="radio"` avec `aria-checked`.
- **Focus visible** : Défini dans `base.css:33-37` :

```css
a:focus-visible, button:focus-visible, .faq-q:focus-visible, .cat:focus-visible {
  outline: 2px solid var(--red);
  outline-offset: 3px;
  border-radius: 8px;
}
```

### Contraste

- Schéma de couleurs sombre (texte blanc `#FAFAFA` sur fond noir `#0A0A0A`).
- Rapport de contraste très élevé (≥ 15:1) ✅.
- Texte secondaire `#A3A3A3` sur `#0A0A0A` ≈ 7:1 ✅ (sauf très petite taille).
- Texte `dim` `#5E5E5E` sur `#0A0A0A` ≈ 3:1 ⚠️ (peut être insuffisant pour les petits textes).

### Éléments favorables au SEO

- `.sr-only-summary` : contenu masqué visuellement mais disponible pour les crawlers et l'IA.
- `itemscope`/`itemprop` sur la FAQ (microdonnées).
- `data-i18n-alt`, `data-i18n-title` : tous les attributs alternatifs sont traduisibles.

### Problèmes d'accessibilité

- Les SVG décoratifs ont `aria-hidden="true"` ✅ mais certains `role="img"` avec `aria-label` redondant (cas des `.feat-icon`).
- Le bouton `lang-switcher` utilise `role="radiogroup"` mais les boutons ne sont pas groupés dans un `<fieldset>`.
- La vidéo n'a pas de `<track>` pour sous-titres.
- Le `#loader` a `role="alert"` mais n'est pas annoncé lorsqu'il est masqué.

---

## 14. Fichiers impliqués

### Tableau récapitulatif

| Fichier | Rôle SEO | Importance |
|---|---|---|
| `menu-scan/index.html` | Balises meta, OG, Twitter, JSON-LD, hreflang, canonical, structure HTML | 🔴 Critique |
| `menu-scan/src/scripts/i18n.js` | Mise à jour dynamique meta title/description/OG/Twitter, html lang/dir | 🔴 Critique |
| `menu-scan/src/locales/fr.js` | Traductions françaises (meta, contenu, JSON-LD indirect) | 🔴 Critique |
| `menu-scan/src/locales/en.js` | Traductions anglaises | 🟡 Important |
| `menu-scan/src/locales/es.js` | Traductions espagnoles | 🟡 Important |
| `menu-scan/src/locales/ar.js` | Traductions arabes (RTL) | 🟡 Important |
| `menu-scan/public/sitemap.xml` | Sitemap avec hreflang XHTML | 🔴 Critique |
| `menu-scan/public/robots.txt` | Règles d'indexation, sitemap reference | 🟡 Important |
| `menu-scan/public/llms.txt` | Information pour IA génératives | 🟢 Optionnel |
| `menu-scan/src/scripts/main.js` | Ordre d'initialisation des modules (i18n first) | 🟡 Important |
| `menu-scan/vite.config.js` | Minification CSS, configuration build | 🟡 Important |
| `menu-scan/src/styles/base.css` | `.sr-only-summary`, focus-visible, contraste | 🟢 Optionnel |
| `menu-scan/src/styles/responsive.css` | Mobile-first responsive (Core Web Vitals) | 🟡 Important |
| `menu-scan/AGENTS.md` | Documentation des priorités SEO pour IA | 🟢 Optionnel |
| `menu-scan/vercel.json` | Configuration build/déploiement | 🟢 Optionnel |

---

## 15. Flux de génération d'une page

### Étape par étape du point de vue SEO

```
1. NAVIGATEUR / CRAWLER FETCH https://menuscan.space/
   │
   ├─ 2. SERVEUR (Vercel) sert index.html (HTML statique complet)
   │
   ├─ 3. HTML REÇU (statique, français)
   │    ├─ <title>                       ← FR
   │    ├─ <meta name="description">     ← FR
   │    ├─ <meta property="og:*">        ← FR
   │    ├─ <meta name="twitter:*">       ← FR
   │    ├─ <link rel="canonical">        ← https://menuscan.space/
   │    ├─ <link rel="alternate" hreflang> ← 5 variantes
   │    ├─ <script type="application/ld+json"> ← Organization, Product, FAQPage
   │    ├─ <link rel="stylesheet">       ← /src/styles/main.css
   │    └─ <script type="module">        ← /src/scripts/main.js
   │
   ├─ 4. CRAWLER (Googlebot)
   │    │   Lit le HTML statique complet
   │    │   ✓ Indexe le title FR
   │    │   ✓ Indexe la meta description FR
   │    │   ✓ Indexe le contenu textuel FR
   │    │   ✓ Parse les JSON-LD (Product, FAQ, Organization)
   │    │   ✓ Lit les hreflangs
   │    │   ✓ Note le canonical
   │    │   ✗ N'exécute PAS le JS (ou partiellement)
   │    │   → Version française indexée ✅
   │    │   → Versions EN/ES/AR non indexées ❌
   │    │
   │    └─ VISITEUR HUMAIN
   │        │   Charge le HTML + CSS + JS
   │        ├─ 5. DOMContentLoaded → main.js
   │        │    ├─ initLoader()        ← Affiche loader 2.5s
   │        │    ├─ await initI18n()    ← Détecte langue, charge locale
   │        │    │    ├─ applyLanguage()
   │        │    │    │    ├─ <html lang="...">           ← Mis à jour
   │        │    │    │    ├─ <html dir="...">            ← LTR/RTL
   │        │    │    │    └─ translatePage()
   │        │    │    │         ├─ <title>                ← Mis à jour (même valeur si FR)
   │        │    │    │         ├─ <meta name="description">  ← Mis à jour
   │        │    │    │         ├─ <meta property="og:*"> ← Mis à jour
   │        │    │    │         ├─ <meta name="twitter:*">← Mis à jour
   │        │    │    │         └─ [data-i18n] éléments   ← Traduits
   │        │    │    └─ changeLanguage() dispatch
   │        │    ├─ initLanguageSwitcher()
   │        │    ├─ initNavbar()
   │        │    ├─ initParticles()      ← Canvas (désactivé tactile)
   │        │    ├─ initPhoneTilt()      ← 3D tilt (désactivé tactile)
   │        │    ├─ initScrambleText()
   │        │    ├─ initFAQ()
   │        │    ├─ initScrollReveal()   ← IntersectionObserver
   │        │    ├─ initSmoothScroll()
   │        │    └─ initMagneticButtons()
   │        │
   │        └─ 6. VISITEUR CHANGE DE LANGUE
   │             └─ language-switcher.js
   │                  └─ changeLanguage(lng)
   │                       ├─ Dynamic import() du fichier locale
   │                       ├─ i18next.changeLanguage()
   │                       ├─ applyLanguage()
   │                       │    ├─ html lang/dir
   │                       │    └─ translatePage() ← Meta + contenu mis à jour
   │                       └─ dispatchEvent('languagechange')
   │                            ├─ scramble-text.js → reinit
   │                            └─ (autres modules écoutent si besoin)
```

### Ce que voit Googlebot

Googlebot voit le HTML statique complet en français. Le JS est partiellement exécuté (Google exécute du JS mais avec des limites). Les métadonnées dynamiques (title, description) ne sont pas garanties d'être lues après exécution JS.

---

## 16. Forces actuelles

### Ce qui est bien implémenté

| # | Force | Détail |
|---|---|---|
| 1 | **HTML statique complet** | Toutes les balises SEO sont présentes dans le HTML initial, pas de rendu JS nécessaire pour l'indexation de base |
| 2 | **JSON-LD bien structuré** | Organization, Product (avec prix MAD), FAQPage — trois schémas utiles |
| 3 | **Balises OG complètes** | og:title, og:description, og:image, og:url, og:type, og:locale — tout est présent |
| 4 | **Twitter Cards** | `summary_large_image` avec title, description, image |
| 5 | **Hreflang complet** | 5 variantes présentes dans `<head>` et sitemap XHTML |
| 6 | **Canonical URL** | Définie et pointe vers le bon domaine |
| 7 | **robots.txt** | Bien configuré avec crawl-delay pour LLM |
| 8 | **Sitemap avec hreflang** | Inclut les variantes XHTML (bonne pratique) |
| 9 | **Performance bundle** | ~22 kB JS gzippé, ~6 kB CSS — excellent |
| 10 | **Pas de framework lourd** | Vanilla JS + Vite → pas de bloat React/Vue |
| 11 | **SVG inline** | Toutes les icônes sont inline (0 requêtes images) |
| 12 | **Preconnect Google Fonts** | Réduit la latence des polices |
| 13 | **Mobile-first responsive** | 3 breakpoints (1024, 768, 480) |
| 14 | **sr-only-summary** | Contenu masqué pour IA/crawlers |
| 15 | **Focus visible** | `:focus-visible` stylé (accessibilité + SEO indirect) |
| 16 | **Microdonnées FAQ** | Double marquage JSON-LD + itemscope |
| 17 | **llms.txt** | Fichier d'information pour IA génératives (pratique émergente) |
| 18 | **CSS minifié** | Via Vite `cssMinify: true` |
| 19 | **Chargement différé des langues** | `import()` dynamique pour EN/ES/AR |
| 20 | **data-i18n-alt et data-i18n-title** | Tous les attributs alternatifs traduisibles |

---

## 17. Faiblesses

### Points faibles identifiés

| # | Faiblesse | Gravité | Fichier(s) |
|---|---|---|---|
| 1 | **`og:image` / `twitter:image` inexistant** | 🔴 Critique | `index.html` |
| 2 | **URLs hreflang `/en/`, `/es/`, `/ar/` inexistantes** | 🔴 Critique | `index.html`, `sitemap.xml` |
| 3 | **`og:locale` non mis à jour dynamiquement** | 🟡 Important | `i18n.js` |
| 4 | **Meta tags dynamiques = version FR toujours indexée** | 🟡 Important | `i18n.js` (limitation JS SEO) |
| 5 | **`telephone` JSON-LD = placeholder `+212-XXX-XXXXXX`** | 🟡 Important | `index.html` |
| 6 | **`logo` JSON-LD = `/og-image.jpg` (inexistant)** | 🟡 Important | `index.html` |
| 7 | **Pas de `preload` / `prefetch`** | 🟡 Important | `index.html` |
| 8 | **HTML non minifié** | 🟡 Important | Vite config |
| 9 | **Pas de Service Worker / cache** | 🟡 Important | Aucun |
| 10 | **`og:image:width`/`height` statiques** | 🟢 Optionnel | `index.html` |
| 11 | **Pas de `WebSite` + `SearchAction` JSON-LD** | 🟢 Optionnel | `index.html` |
| 12 | **Pas de `LocalBusiness` JSON-LD** | 🟡 Important | `index.html` |
| 13 | **Vidéo sans sous-titres (`<track>`)** | 🟢 Optionnel | `index.html` |
| 14 | **Aucune redirection pour `/en/`, `/es/`, `/ar/`** | 🟡 Important | Aucun fichier |
| 15 | **`sameAs` limité (Instagram seulement)** | 🟢 Optionnel | `index.html` |
| 16 | **`twitter:site` non défini** | 🟢 Optionnel | `index.html` |
| 17 | **`lastmod` du sitemap non mis à jour** | 🟢 Optionnel | `sitemap.xml` |
| 18 | **L'URL ne change pas avec la langue** | 🟢 Optionnel | `i18n.js` |
| 19 | **Contraste `#5E5E5E` sur `#0A0A0A` limite** | 🟢 Optionnel | `base.css` |
| 20 | **Pas de balisage `Article` (pas de blog)** | 🟢 Optionnel | N/A |

---

## 18. Recommandations

### Critique (doit être fait immédiatement)

| # | Recommandation | Détail technique | Fichier |
|---|---|---|---|
| **C1** | **Créer `/og-image.jpg`** | Ajouter une image 1200×630 dans `public/` ou utiliser un service dynamique | `public/og-image.jpg` |
| **C2** | **Créer les pages `/en/`, `/es/`, `/ar/` ou rediriger** | Soit créer des entrées Vercel, soit rediriger vers `/` avec en-tête `Content-Language`. Solution rapide : redirection 301 vers la racine | `vercel.json` ou nouveau fichier |
| **C3** | **Corriger `telephone` JSON-LD** | Remplacer `+212-XXX-XXXXXX` par un vrai numéro ou retirer le champ si indisponible | `index.html:72` |

### Important (à faire rapidement)

| # | Recommandation | Détail technique | Fichier |
|---|---|---|---|
| **I1** | **Mettre à jour `og:locale` dynamiquement** | Ajouter une entrée `meta.locale` dans les fichiers de locale et mettre à jour l'attribut dans `translatePage()` | `i18n.js`, `fr.js`, `en.js`, `es.js`, `ar.js` |
| **I2** | **Ajouter `preload` pour les ressources critiques** | `preload` le CSS principal et `modulepreload` pour `main.js` | `index.html` |
| **I3** | **Minifier HTML** | Ajouter `minifyHTML: true` ou un plugin Vite | `vite.config.js` |
| **I4** | **Ajouter `LocalBusiness` JSON-LD** | Créer un schéma `LocalBusiness` avec l'adresse de Casablanca pour le SEO local Maroc | `index.html` |
| **I5** | **Ajouter `dns-prefetch` pour les domaines externes** | `fonts.googleapis.com`, `fonts.gstatic.com`, `wa.me` | `index.html` |
| **I6** | **Corriger le logo JSON-LD** | Utiliser une vraie image de logo dans `public/` ou un SVG inline | `public/logo.svg`, `index.html` |
| **I7** | **Rediriger `/en/`, `/es/`, `/ar/` vers `/`** | Configurer des redirections 301 dans `vercel.json` | `vercel.json` |

### Optionnel (bonnes pratiques)

| # | Recommandation | Détail |
|---|---|
| **O1** | Ajouter des sous-titres (`<track>`) à la vidéo démo | Améliore accessibilité + SEO vidéo |
| **O2** | Ajouter `twitter:site` | Même si pas de compte Twitter, valeur vide = mieux que absent |
| **O3** | Ajouter `WebSite` + `SearchAction` JSON-LD | Pour la search box dans les SERP |
| **O4** | Ajouter `prefers-color-scheme` | Support dark mode natif |
| **O5** | Mettre à jour `lastmod` du sitemap automatiquement | Via script de build ou GitHub Actions |
| **O6** | Ajouter `manifest.json` | Pour PWA (bon signal utilisateur) |
| **O7** | Ajouter `Article` JSON-LD si blog/cas client ajouté | Pour les futures pages de contenu |
| **O8** | Améliorer contraste `--dim` (`#5E5E5E` → `#7A7A7A`) | Pour WCAG AA sur petits textes |
| **O9** | Ajouter `history.pushState` pour changement de langue | Pour que l'URL reflète la langue (`?lng=en`) |
| **O10** | Ajouter un générateur de sitemap dynamique | Plugin Vite ou script post-build |

---

## 19. Score SEO

### Grille d'évaluation

| Catégorie | Score | Justification |
|---|---|---|
| **Technique** | 78/100 | HTML statique complet, JSON-LD, sitemap, robots.txt — manque minification HTML, preload, redirections hreflang |
| **Performance** | 85/100 | Bundle très léger, CSS minifié, SVG inline — Google Fonts et absence de preload/fetch pénalisent |
| **Accessibilité** | 72/100 | Bonne hiérarchie H1-H3, aria-labels, focus visible — contraste limite, pas de sous-titres vidéo, pas de skip link |
| **Indexation** | 65/100 | Page FR bien indexable — les hreflangs vers des pages inexistantes diluent le signal, meta dynamiques non lues par Google |
| **Contenu** | 82/100 | Contenu bien rédigé, unique, mots-clés pertinents (QR Code, Maroc, 500 DH), FAQ utile — pas de blog, pas de contenu frais |
| **Score global** | **76/100** | Bonnes bases SEO, points critiques à corriger (og:image, redirections hreflang). Le site est léger, rapide, bien structuré pour une page unique |

### Détail du scoring

| Critère | Points | Max |
|---|---|---|
| Balises title/meta | 8 | 10 |
| Open Graph | 7 | 10 |
| Twitter Cards | 6 | 10 |
| JSON-LD | 8 | 10 |
| Sitemap | 7 | 10 |
| robots.txt | 8 | 10 |
| Hreflang | 5 | 10 |
| Canonical | 9 | 10 |
| Performance | 8 | 10 |
| Mobile | 9 | 10 |
| Images | 6 | 10 |
| Accessibilité | 7 | 10 |
| Contenu | 8 | 10 |
| Internationalisation | 5 | 10 |
| **Total** | **101** | **140** → **72%** (pondéré → 76/100) |

### Priorités d'action

```
Urgence    ┃ Action
───────────╂────────────────────────────────────────────
🔴 NOW     ┃ Créer og-image.jpg (C1)
🔴 NOW     ┃ Créer/rediriger pages /en/, /es/, /ar/ (C2)
🔴 NOW     ┃ Corriger téléphone JSON-LD (C3)
🟡 SOON    ┃ og:locale dynamique (I1)
🟡 SOON    ┃ Ajouter LocalBusiness JSON-LD (I4)
🟡 SOON    ┃ Ajouter preload/prefetch (I2)
🟡 SOON    ┃ Minifier HTML (I3)
🟢 LATER   ┃ Service Worker / cache (I5+)
🟢 LATER   ┃ WebSite SearchAction (O3)
🟢 LATER   ┃ history.pushState pour langue (O9)
```

---

*Document généré pour l'audit SEO de `menu-scan/` — Projet landing page Vite.*
