/**
 * Menu Scan — Publication automatisée du Blog
 * Module : TemplateLoader.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : charger le gabarit d'article depuis GitHub, en
 * lecture seule, et garantir qu'il est exploitable.
 *
 * Sûreté (décision D3) :
 *   - le gabarit est TOUJORS lu depuis le dépôt (source de vérité) ;
 *     aucune copie locale, aucun repli silencieux ;
 *   - le gabarit conserve `noindex, nofollow` (exigé par le test AC-8) ;
 *     le basculement en `index, follow` est fait par le moteur sur la sortie
 *     générée, jamais dans le fichier ;
 *   - les assets du gabarit restent à 1 niveau (le gabarit vit à la racine
 *     de blog/) ; c'est la sortie générée, à blog/{lang}/, qui reçoit 2 niveaux.
 *
 * PHASE 2 : chargement + validation uniquement. Le rendu arrive en phase 4.
 */

/**
 * Charge le gabarit depuis le dépôt.
 * @return {{ok:boolean, html?:string, sha?:string, path:string,
 *           validation:Object, error?:string}}
 */
function loadArticleTemplate() {
  var path = APP.TEMPLATE_PATH;

  var file;
  try {
    file = getFile(path);
  } catch (e) {
    return {
      ok: false,
      path: path,
      validation: null,
      error: 'Lecture du gabarit impossible (' + path + ', branche ' +
        getGithubBranch() + ') : ' + redact(e.message)
    };
  }

  if (!file) {
    return {
      ok: false,
      path: path,
      validation: null,
      error: 'Gabarit introuvable dans le dépôt : ' + path +
        ' (branche ' + getGithubBranch() + ', préfixe « ' +
        (getGithubPathPrefix() || 'aucun') + ' »)' +
        (getGithubPathPrefix() ? '' :
          ' — Le projet est-il dans un sous-dossier du dépôt ? Renseignez GITHUB_PATH_PREFIX.')
    };
  }

  var validation = validateTemplate(file.content);
  if (!validation.ok) {
    return {
      ok: false,
      path: path,
      validation: validation,
      error: 'Gabarit invalide : ' + validation.errors
        .map(function (e) { return e.code + ' ' + e.message; }).join(' ; ')
    };
  }

  return {
    ok: true,
    path: path,
    html: file.content,
    sha: file.sha,
    size: file.size,
    validation: validation
  };
}

/**
 * Contrat de post-traitement, documenté et déterministe (décision D3).
 * Cette fonction ne rend PAS encore l'article : elle décrit et verrouille
 * les transformations que le moteur devra appliquer. Le moteur de rendu
 * (Renderer.gs) s'appuie sur ces règles.
 *
 * Les 6 transformations, dans l'ordre :
 *  1. Substitution des placeholders du gabarit.
 *  2. Profondeur : « assets/… » → « ../assets/… » (sortie à /blog/{lang}/).
 *  3. Robots : « noindex, nofollow » → « index, follow » (occurrence unique).
 *  4. Suppression du commentaire de développement du gabarit.
 *  5. Image de couverture et metas og:image en chemin ABSOLU (/blog/images/…).
 *  6. Vérification : validateRenderedHtml() avant toute écriture.
 *
 * AUCUNE réécriture vers `blog/{categorie}/` : les articles sont publiés dans
 * `blog/{LANG}/{SLUG}.html`, et le lien de retour du gabarit est `/blog/`.
 *
 * @return {{depth:boolean, robots:boolean, favicon:boolean, devComment:boolean,
 *           backLink:boolean, canonical:boolean}}
 */
function templatePostProcessContract() {
  return {
    depth: true,        // assets/ → ../assets/
    robots: true,       // noindex, nofollow → index, follow
    favicon: true,      // data: URI inline, alignée sur les articles publiés
    devComment: true,   // commentaire « Remplacer tous les {{PLACEHOLDER}} » retiré
    backLink: true,     // /blog/ conservé tel quel
    canonical: true     // https://menuscan.space + /blog/{lang}/{slug}.html
  };
}

/**
 * Contrôle de l'état du gabarit sans l'utiliser.
 * Utile au diagnostic : signale un gabarit qui a divergé du contrat D3.
 *
 * @return {{ok:boolean, warnings:string[]}}
 */
function checkTemplateContract() {
  var loaded = loadArticleTemplate();
  if (!loaded.ok) return { ok: false, warnings: [loaded.error] };

  var warnings = (loaded.validation.warnings || []).map(function (w) {
    return w.code + ' ' + w.message;
  });
  return { ok: true, warnings: warnings, sha: loaded.sha, size: loaded.size };
}
