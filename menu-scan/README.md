# Menu Scan — Landing Page

Page d'accueil pour **Menu Scan**, un service de menu digital QR Code avec paiement unique, sans abonnement.

## Architecture

```
menu-scan/
├── index.html                   # Point d'entrée HTML (structure complète)
├── package.json                 # Dépendances et scripts
├── vite.config.js               # Configuration Vite
├── .gitignore
├── README.md
└── src/
    ├── assets/
    │   └── icons/               # Icônes SVG réutilisables (14 fichiers)
    ├── styles/
    │   ├── base.css             # Reset, variables CSS, typographie
    │   ├── layout.css           # Nav, hero, sections, footer
    │   ├── components.css       # Loader, badges, boutons, phone, steps, etc.
    │   ├── animations.css       # Keyframes, scroll reveal
    │   ├── responsive.css       # Media queries
    │   └── main.css             # Point d'entrée (@import de tous les CSS)
    └── scripts/
        ├── loader.js            # Animation de chargement initial
        ├── navbar.js            # Effet scroll sur la navbar
        ├── particles.js         # Canvas particles dans le hero
        ├── phone-tilt.js        # Effet 3D sur le mockup téléphone
        ├── scramble-text.js     # Animation de texte "scramble"
        ├── faq.js               # Accordéon FAQ
        ├── scroll-reveal.js     # IntersectionObserver reveal
        ├── smooth-scroll.js     # Navigation smooth scroll
        ├── magnetic-buttons.js  # Effet magnétique sur les boutons
        └── main.js              # Initialise tous les modules
```

## Installation

```bash
npm install
```

## Développement

```bash
npm run dev
```

Ouvre [http://localhost:3000](http://localhost:3000) dans le navigateur.

## Build production

```bash
npm run build
```

Les fichiers optimisés sont générés dans le dossier `dist/`.

## Preview du build

```bash
npm run preview
```

## Notes

- **SVG** : Les icônes sont conservées inline dans le HTML (pour conserver `currentColor`), mais également disponibles en fichiers standalone dans `src/assets/icons/`.
- **CSS** : Architecture modulaire avec `@import` dans `main.css`. Chaque fichier gère une responsabilité unique.
- **JS** : Modules ES6 avec export/import. Tous initialisés dans `main.js` au `DOMContentLoaded`.
- **Aucune modification visuelle** : Le rendu est identique à l'original (mêmes sélecteurs, mêmes animations, mêmes couleurs).
