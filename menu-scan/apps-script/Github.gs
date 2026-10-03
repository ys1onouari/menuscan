/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Github.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : client de l'API GitHub (repos + Contents).
 *
 * Opérations : getRepositoryInfo, testGithubConnection, getFile,
 *              createOrUpdateFile, deleteFile.
 *
 * Chemins : `public/blog/{lang}/{slug}.html` est la SEULE forme qu'un article
 * peut occuper (ARTICLE_PATH_RE). Une liste de refus explicite est évaluée
 * AVANT ce motif, car le motif seul est nécessaire mais non suffisant.
 *
 * SÉCURITÉ — deux verrous indépendants, tous deux fermés par défaut :
 *   1. GITHUB_WRITE_ENABLED (Script Property) : coupe createOrUpdateFile.
 *   2. TEST_MODE (Config, TRUE par défaut) : coupe toute écriture même si le
 *      premier verrou est levé.
 * Le test de connexion est en lecture seule (GET /repos/...).
 */

/** Message Levé quand une écriture est tentée alors que les verrous sont fermés. */
var ERR_WRITES_DISABLED =
  'Écriture GitHub désactivée (GITHUB_WRITE_ENABLED=FALSE). ' +
  'Aucune modification n\'a été effectuée.';

var ERR_TEST_MODE =
  'TEST_MODE=TRUE : aucune écriture GitHub n\'est effectuée.';

/* -------------------------------------------------------------------------- */
/* Couche HTTP bas niveau                                                    */
/* -------------------------------------------------------------------------- */

/** User-Agent obligatoire de l'API GitHub, et signature du projet. */
var GITHUB_USER_AGENT = 'Menu-Scan-Blog-Automation';

function ghHeaders(extra) {
  var headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': GITHUB_USER_AGENT
  };
  var token = getGithubToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (extra) {
    Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
  }
  return headers;
}

function ghUrl(path) {
  var base = getGithubApiBase();
  return /^https?:\/\//.test(path) ? path : base + path;
}

/**
 * Effectue un appel API et normalise les erreurs.
 * @return {Object} réponse UrlFetchApp
 * @throws {Error} message nettoyé (jamais de token)
 */
function ghRequest(method, path, payload) {
  var response = httpRequest({
    url: ghUrl(path),
    method: method,
    headers: ghHeaders(payload ? { 'Content-Type': 'application/json' } : null),
    payload: payload ? toJson(payload) : null,
    retries: getConfigNumber('MAX_RETRIES', 3)
  });

  var code = response.getResponseCode();
  if (code >= 200 && code < 300) return response;

  throw new Error(ghErrorMessage(code, response.getContentText()));
}

/** Traduit un statut HTTP en message exploitable, sans jamais fuiter le token. */
function ghErrorMessage(code, body) {
  var detail = '';
  try {
    var parsed = JSON.parse(body || '{}');
    if (parsed && parsed.message) detail = parsed.message;
  } catch (e) {
    // corps non JSON : on reste générique
  }
  var hint = '';
  if (code === 401) hint = ' (token absent, expiré ou sans permission)';
  if (code === 403) hint = ' (permission insuffisante sur le dépôt)';
  if (code === 404) hint = ' (dépôt, branche ou fichier introuvable)';
  return 'GitHub API ' + code + hint + (detail ? ' : ' + redact(detail) : '');
}

/* -------------------------------------------------------------------------- */
/* Opérations en lecture                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Informations du dépôt.
 * @return {{fullName:string, defaultBranch:string, private:boolean, push:boolean}}
 */
function getRepositoryInfo() {
  var response = ghRequest('get', '/repos/' + getGithubOwner() + '/' + getGithubRepository());
  var data = JSON.parse(response.getContentText());
  return {
    fullName: String(data.full_name || ''),
    defaultBranch: String(data.default_branch || ''),
    private: data.private === true,
    push: !!(data.permissions && data.permissions.push)
  };
}

/**
 * Test de connexion, en lecture seule.
 * Vérifie que : le token est présent, le dépôt répond, la branche configurée
 * existe, et que le token dispose du droit d'écriture (information seule :
 * aucune écriture n'est tentée).
 *
 * NE LÈVE JAMAIS d'exception. C'est un DIAGNOSTIC : une Script Property
 * manquante, un dépôt injoignable ou un token absent doivent être RAPPORTÉS
 * dans `errors`, pas interrompre l'appelant. Les identifiants sont donc lus
 * en mode « doux » (optionalProp) et l'appel réseau n'est tenté que si le
 * trio owner/repository est complet.
 *
 * @return {{ok:boolean, checks:Object, errors:string[]}}
 */
function testGithubConnection() {
  var checks = {
    tokenConfigured: !!getGithubToken(),
    owner: optionalProp(PROP_KEYS.OWNER),
    repository: optionalProp(PROP_KEYS.REPOSITORY),
    branch: optionalProp(PROP_KEYS.BRANCH),
    apiBase: getGithubApiBase(),
    reachable: false,
    defaultBranchMatches: false,
    canPush: false
  };
  var errors = [];

  if (!checks.tokenConfigured) {
    errors.push('GITHUB_TOKEN absent des Script Properties');
  }
  if (!checks.owner) {
    errors.push('GITHUB_OWNER absent des Script Properties (propriétaire du dépôt)');
  }
  if (!checks.repository) {
    errors.push('GITHUB_REPOSITORY absent des Script Properties (nom du dépôt)');
  }
  if (!checks.branch) {
    errors.push('GITHUB_BRANCH absent des Script Properties (branche de publication)');
  }

  if (checks.owner && checks.repository) {
    try {
      var info = getRepositoryInfo();
      checks.reachable = true;
      checks.fullName = info.fullName;
      checks.private = info.private;
      checks.canPush = info.push;
      if (!checks.branch) {
        errors.push('Branche non configurée : impossible de vérifier GITHUB_BRANCH');
      } else if (info.defaultBranch !== checks.branch) {
        errors.push('Branche configurée « ' + checks.branch +
          ' » ≠ branche par défaut « ' + info.defaultBranch + ' »');
      } else {
        checks.defaultBranchMatches = true;
      }
    } catch (e) {
      errors.push(redact(e.message));
    }
  }

  return { ok: errors.length === 0, checks: checks, errors: errors };
}

/**
 * Lit un fichier du dépôt.
 * @param {string} path chemin relatif, ex. blog/template-article.html
 * @return {{sha:string, path:string, content:string, size:number}|null}
 *          null si le fichier n'existe pas (404)
 */
function getFile(path) {
  var url = '/repos/' + getGithubOwner() + '/' + getGithubRepository() +
    '/contents/' + path + '?ref=' + encodeURIComponent(getGithubBranch());
  var response;
  try {
    response = ghRequest('get', url, null);
  } catch (e) {
    if (String(e.message).indexOf('GitHub API 404') !== -1) return null;
    throw e;
  }
  return decodeContentResponse(JSON.parse(response.getContentText()));
}

/** Décode la réponse `contents` (base64, sauts de ligne inclus). */
function decodeContentResponse(data) {
  if (!data || data.type !== 'file') return null;
  var content = String(data.content || '').replace(/\n/g, '');
  return {
    sha: String(data.sha || ''),
    path: String(data.path || ''),
    // Utilities.base64Decode() renvoie un Byte[] (tableau d'octets signes),
    // PAS un String. Sans le passage par un Blob, `content` arrivait non-string
    // aux appelants (validateTemplate, re.exec sur Config) et echouait sur
    // « html.replace is not a function ». On produit donc reellement le String
    // promis par le contrat @return de getFile().
    content: Utilities.newBlob(Utilities.base64Decode(content)).getDataAsString('UTF-8'),
    size: Number(data.size || 0)
  };
}

/** Le chemin existe-t-il déjà ? (contrôle de doublon, décision de validation) */
function fileExists(path) {
  return getFile(path) !== null;
}

/* -------------------------------------------------------------------------- */
/* Opérations en écriture (verrouillées)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Les écritures sont impossibles tant que GITHUB_WRITE_ENABLED n'est pas TRUE.
 * Cette fonction est le point d'entrée unique pour toute écriture.
 *
 * Principe de sécurité : ÉCHEC FERMÉ (fail closed). Si la feuille Config est
 * absente, on ne retombe PAS sur les valeurs par défaut — un TEST_MODE lu à
 * « FALSE » par défaut autoriserait une écriture alors que la configuration
 * n'a jamais été posée. On refuse donc tant que Config n'est pas initialisée.
 *
 * @throws {Error} si un verrou est fermé ou si la configuration est absente
 */
function assertWritesAllowed() {
  if (!writesEnabled()) throw new Error(ERR_WRITES_DISABLED);
  if (!getConfigSheet()) {
    throw new Error(
      'Feuille Config absente : initialisation requise avant toute écriture ' +
      '(menus « Initialiser les feuilles »).'
    );
  }
  if (getConfigBoolean('TEST_MODE')) throw new Error(ERR_TEST_MODE);
}

/**
 * Crée ou met à jour un fichier via l'API Contents.
 *
 * Appelé par Publisher.gs (phase publication) ; protégé par
 * assertWritesAllowed(). En cas d'échec, l'appelant reçoit une exception et
 * ne doit marquer l'article PUBLISHED qu'après succès.
 *
 * @param {{path:string, content:string, message:string, sha?:string, branch?:string}} opt
 * @return {{sha:string, commitSha:string, path:string}}
 */
function createOrUpdateFile(opt) {
  assertWritesAllowed();

  var path = String(opt.path || '');
  if (!path) throw new Error('Chemin vide');
  var branch = opt.branch || getGithubBranch();

  var payload = {
    message: String(opt.message || 'Publication article Blog'),
    content: Utilities.base64Encode(Utilities.newBlob(opt.content).getBytes()),
    branch: branch
  };
  if (opt.sha) payload.sha = opt.sha;

  var response = ghRequest(
    'put',
    '/repos/' + getGithubOwner() + '/' + getGithubRepository() +
      '/contents/' + path,
    payload
  );

  var data = JSON.parse(response.getContentText());
  return {
    sha: String((data.content && data.content.sha) || ''),
    commitSha: String((data.commit && data.commit.sha) || ''),
    path: String((data.content && data.content.path) || path)
  };
}

/**
 * Vérifie que les prérequis d'écriture sont reunis (sans écrire).
 * @return {{ok:boolean, errors:string[]}}
 */
function checkWriteReadiness() {
  var errors = [];
  if (!writesEnabled()) {
    errors.push('GITHUB_WRITE_ENABLED=FALSE (verrou fermé)');
  }
  if (!getConfigSheet()) {
    errors.push('Feuille Config absente (initialisation requise)');
  } else if (getConfigBoolean('TEST_MODE')) {
    errors.push('TEST_MODE=TRUE : aucune écriture ne sera effectuée');
  }
  var conn = testGithubConnection();
  if (!conn.ok) errors = errors.concat(conn.errors);
  return { ok: errors.length === 0, errors: errors };
}

/* -------------------------------------------------------------------------- */
/* Suppression (verrouillée) — D5                                             */
/* -------------------------------------------------------------------------- */

/**
 * Forme STRUCTURELLE d'un chemin d'article :
 * public/blog/<fr|en|es|ar>/<slug>.html
 *
 * ATTENTION — ce motif seul est INSUFFISANT et ne doit jamais être utilisé
 * seul comme garde-fou. La défense réelle est denyArticlePathReason(), qui
 * ajoute une liste de refus explicite evaluated AVANT ce motif, puis
 * validateArticleFilePath().
 *
 * La langue est volontairement restreinte aux 4 codes de APP.SUPPORTED_LANGS :
 * un chemin `public/blog/de/…` ne doit jamais être considéré comme un article
 * du blog.
 *
 /**
 * Motif et CAPTURES : m[1] = langue, m[2] = slug.
 * Le slug est encadré par `[a-z0-9]+(-[a-z0-9]+)*` : ni dash initial, ni
 * dash final, ni double dash — c'est plus strict que `[a-z0-9-]+`, donc
 * davantage de chemins refusés à l'entrée.
 *
 * Ce motif couvre déjà, par construction : les répertoires (`/` final), la
 * traversée (`.`), les antislash, les chemins encodés (`%`), les jokers (`*`),
 * les chemins absolus (`/` initial) et les segments non slug (`_`, accents,
 * majuscules).
 */
var ARTICLE_PATH_RE = /^public\/blog\/(fr|en|es|ar)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.html$/;

/** Un index de langue : public/blog/<lang>/index.html (INTERDIT). */
var LANGUAGE_INDEX_RE = /^public\/blog\/(fr|en|es|ar)\/index\.html$/;

/**
 * Décrit pourquoi un chemin est INTERDIT, ou null s'il n'est pas interdit.
 *
 * Les listes de refus sont ÉVALUÉES AVANT le motif et avant toute écriture :
 * ce sont elles qui portent l'invariant « jamais le hub, jamais le gabarit,
 * jamais le sitemap, jamais un index, jamais un asset ». Chaque chemin est
 * nommé en toutes lettres : une liste de refus muette est impossible à relire.
 *
 * @param {string} path
 * @return {?string} motif du refus, ou null
 */
function denyArticlePathReason(path) {
  var value = String(path === null || path === undefined ? '' : path);
  if (!value) return 'chemin vide';

  var exact = [
    { path: APP.HUB_PATH, what: 'le hub du Blog' },
    { path: APP.TEMPLATE_PATH, what: 'le gabarit' },
    { path: APP.SITEMAP_PATH, what: 'le sitemap' },
    { path: APP.ARTICLES_INDEX_PATH, what: 'l\'index des articles (articles.json)' }
  ];
  for (var i = 0; i < exact.length; i++) {
    if (value === exact[i].path) return exact[i].what;
  }

  var prefixes = [
    { prefix: APP.BLOG_ASSETS_DIR + '/', what: 'le répertoire assets' },
    { prefix: APP.BLOG_IMAGES_DIR + '/', what: 'le répertoire images' }
  ];
  for (var j = 0; j < prefixes.length; j++) {
    if (value.indexOf(prefixes[j].prefix) === 0) return prefixes[j].what;
  }

  if (LANGUAGE_INDEX_RE.test(value)) return 'un index de langue';
  return null;
}

/**
 * Décompose un chemin d'article en langue + slug.
 *
 * @param {string} path chemin relatif au dépôt
 * @return {?{lang:string, slug:string}} null si le chemin n'est pas un article
 */
function parseArticlePath(path) {
  var m = ARTICLE_PATH_RE.exec(String(path === null || path === undefined ? '' : path).trim());
  if (!m) return null;
  if (!isSupportedLang(m[1])) return null;
  if (!isValidSlug(m[2])) return null;
  return { lang: m[1], slug: m[2] };
}

/**
 * Vérifie l'IDENTITÉ d'un chemin : il doit désigner CET article, c'est-à-dire
 * la langue et le slug attendus.
 *
 * Contrôle STRUCTURELLE, pas de provenance : il ne prouve pas que la ligne de
 * la feuille est bien celle qui a produit le fichier. C'est le rôle de
 * Publisher.gs, qui compare la colonne GITHUB_PATH au chemin DÉRIVÉ de
 * LANG + SLUG avant toute écriture.
 *
 * @param {string} path
 * @param {string} lang langue attendue
 * @param {string} slug slug attendu
 * @return {{lang:string, slug:string}}
 * @throws {Error} si le chemin n'est pas un article ou ne correspond pas
 */
function assertArticlePathIdentity(path, lang, slug) {
  var value = String(path === null || path === undefined ? '' : path);
  var parsed = parseArticlePath(value);
  if (!parsed) {
    throw new Error(
      'Chemin d\'article invalide : « ' + value + ' » ' +
      '(forme attendue : ' + APP.BLOG_DIR + '/<lang>/<slug>.html).'
    );
  }
  if (parsed.lang !== lang || parsed.slug !== slug) {
    throw new Error(
      'Chemin et article incohérents : « ' + value + ' » désigne ' +
      parsed.lang + '/' + parsed.slug + ' alors que la ligne décrit ' +
      lang + '/' + slug + '.'
    );
  }
  return parsed;
}

/**
 * Vérifie qu'un chemin est bien celui d'un ARTICLE, et rien d'autre.
 *
 * Fonction PURE et SÛRE-FAILLE : toute ambiguïté est refusée. Aucune écriture
 * n'est tentée. C'est la seule défense propre de deleteFile(), qui ne connaît
 * pas la feuille : la validation d'IDENTITÉ (la ligne correspond-elle à ce
 * chemin ?) appartient à Publisher.gs et s'appuie sur
 * assertArticlePathIdentity().
 *
 * @param {string} path chemin relatif déjà validé comme `GITHUB_PATH`
 * @throws {Error} si le chemin n'est pas un article
 */
function validateArticleFilePath(path) {
  var value = String(path === null || path === undefined ? '' : path);

  var refused = denyArticlePathReason(value);
  if (refused) {
    throw new Error('Suppression refusée : « ' + value + ' » est ' + refused + '.');
  }

  if (!ARTICLE_PATH_RE.test(value)) {
    throw new Error(
      'Suppression refusée : « ' + value + ' » n\'a pas la forme attendue ' +
      '(' + APP.BLOG_DIR + '/<lang>/<slug>.html). Aucun joker, aucun répertoire, ' +
      'aucune traversée.'
    );
  }

  return true;
}

/**
 * Supprime UN fichier du dépôt via l'API Contents.
 *
 *Appelé par Publisher.gs (opération « supprimer un article publié ») ; protégé
 * par assertWritesAllowed(), exactement comme createOrUpdateFile(). Aucune
 * suppression récursive, aucune suppression de répertoire : le SHA est
 * obligatoire, ce qui interdit le mode `recursive` de l'API Contents — un
 * appel sans SHA échouerait, un appel avec SHA ne peut viser qu'UN fichier.
 *
 * Le chemin NE DOIT PAS provenir d'une saisie utilisateur : il vient de la
 * colonne GITHUB_PATH d'une ligne `Articles`, et n'a atteint cette fonction
 * qu'après avoir été comparé au chemin DÉRIVÉ de CATEGORY + CATEGORY_MAP +
 * SLUG (invariant d'identité). validateArticleFilePath() n'en est pas le
 * substitut : il borne la STRUCTURE du chemin, pas sa provenance.
 *
 * @param {{path:string, sha:string, message?:string}} opt
 *        `branch` est volontairement IGNORÉ : le paramètre est obsolète dans
 *        l'API Contents (2022-11-28) et une seule source de vérité de branche
 *        doit exister dans le projet.
 * @return {{code:number, deleted:boolean, commitSha:string, path:string}}
 * @throws {Error} si un verrou d'écriture est fermé, si le chemin n'est pas un
 *         article, si le SHA est absent, ou si l'API répond en erreur
 */
function deleteFile(opt) {
  // Point d'entrée UNIQUE d'écriture : aucune requête réseau avant cette ligne.
  assertWritesAllowed();

  var path = String(opt && opt.path ? opt.path : '');
  validateArticleFilePath(path);

  // SHA obligatoire : garde-fou contre la suppression récursive de répertoires.
  var sha = String(opt && opt.sha ? opt.sha : '');
  if (!sha) {
    throw new Error(
      'Suppression refusée : SHA obligatoire pour ' + path +
      ' (il empêche toute suppression récursive).'
    );
  }

  var response = ghRequest(
    'delete',
    '/repos/' + getGithubOwner() + '/' + getGithubRepository() + '/contents/' + path,
    // `sha` est EXIGE par l'API Contents : sans lui l'appel échoue (422) au
    // lieu de supprimer, et il interdit toute suppression récursive. Il est
    // transmis à l'identique, jamais recalculé.
    {
      message: String(opt.message || ('Suppression : ' + path)),
      sha: sha
    }
  );

  var data = JSON.parse(response.getContentText());
  // L'API renvoie `content: null` sur un DELETE réussi : le SHA du fichier
  // supprimé n'est donc PAS relisible, seul celui du commit l'est.
  return {
    code: response.getResponseCode(),
    deleted: true,
    commitSha: String((data && data.commit && data.commit.sha) || ''),
    path: path
  };
}
