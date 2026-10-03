/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Publisher.gs
 * ---------------------------------------------------------------------------
 * Responsabilité unique : publier UN SEUL article, de bout en bout.
 *
 * PHASE 4 — le pipeline est strictement séquentiel et traçable :
 *
 *   sélection → verrou → READY/DRAFT → PUBLISHING → gabarit → rendu
 *   → validation (contrat de production) → TEST_MODE / verrou d'écriture
 *   → Contents API (create ou update) → PUBLISHED
 *
 *   Toute défaillance contrôlée (ligne, gabarit, rendu, validation, GitHub)
 *   repasse la ligne en ERROR avec un message ; un simple verrou d'écriture
 *   fermé ou un mode test ne sont PAS des erreurs d'article : la ligne est
 *   rendue à son statut d'origine pour rester publiable.
 *
 * SÛRETÉ (invariants non négociables) :
 *   - UN seul article par exécution, jamais de lot ;
 *   - le verrou est acquis en ÉCHEC RAPIDE (tryLock) : si une publication est
 *     déjà en cours, on n'attend pas et on ne continue pas ;
 *   - le rendu ET sa validation ont lieu AVANT toute écriture, y compris en
 *     mode test : le mode test exerce donc réellement le moteur ;
 *   - TEST_MODE puis GITHUB_WRITE_ENABLED sont vérifiés par le point d'entrée
 *     unique existant assertWritesAllowed() — aucun second chemin d'écriture ;
 *   - le message de commit est déterministe et le contenu inchangé n'est pas
 *     réécrit : republier le même article ne crée aucun doublon logique.
 *
 * AUCUNE publication réelle n'est possible tant que TEST_MODE = TRUE
 * (valeur par défaut de CONFIG_DEFAULTS).
 */

/** Attente maximale du verrou de script, en ms. Échec rapide assumé. */
var PUBLISH_LOCK_MS = 1000;

/** Nombre de relectures du SHA après un conflit 409 (1 = borné, déterministe). */
var PUBLISH_CONFLICT_RETRIES = 1;

/**
 * Attente du verrou de script pour une SUPPRESSION (D5).
 *
 * Volontairement IDENTIQUE à PUBLISH_LOCK_MS : une suppression et une
 * publication ne doivent jamais se chevaucher, et le même délai évite qu'une
 * suppression patiente bloque une publication (ou l'inverse) plus longtemps que
 * nécessaire. Le verrou reste commun et unique : toute écriture du projet y passe.
 */
var DELETE_LOCK_MS = 1000;

/**
 * Statuts qui interdisent de relancer une publication.
 *
 * Construit à l'appel, et NON à la charge du fichier : Apps Script charge les
 * .gs par ordre alphabétique (Code, Config, Github, Logger, Publisher, …), donc
 * `STATUS` — défini dans Sheets.gs — n'existe pas encore ici. Une constante de
 * haut niveau qui le référencerait interromprait le chargement du projet.
 */
function publishBlockedStatuses() {
  return [STATUS.PUBLISHING, STATUS.PUBLISHED, STATUS.ERROR];
}

/* -------------------------------------------------------------------------- */
/* Entrées de menu                                                            */
/* -------------------------------------------------------------------------- */

/** Publie l'article situé sur la ligne sélectionnée de la feuille `Articles`. */
function publishSelectedArticle() {
  try {
    var selection = selectActiveArticle();
    if (!selection.ok) {
      logWarning('publish_selected', selection.error, {});
      alertOrLog('Publication : ÉCHEC\n\n' + selection.error);
      return failure('NO_SELECTION', selection.error, null);
    }

    var result = publishArticleById(selection.article.ID);
    alertOrLog(formatPublishReport(result));
    return result;
  } catch (e) {
    var message = redact(String(e && e.message ? e.message : e));
    logError('publish_selected', message, {});
    alertOrLog('Publication : ÉCHEC\n\n' + message);
    return failure('UNEXPECTED', message, null);
  }
}

/**
 * Publie le premier article READY, dans l'ordre de la feuille.
 * Les suivants ne sont PAS traités : le contrat reste « un article par
 * exécution ». Leur nombre est rapporté à l'opérateur.
 */
function publishNextReadyArticle() {
  try {
    var ready = findArticlesByStatus(STATUS.READY);
    if (!ready.length) {
      logInfo('publish_next', 'Aucun article READY à publier', { total: 0 });
      alertOrLog('Publication : aucun article READY.\n\nPassez une ligne en READY pour la publier.');
      return failure('NO_READY', 'Aucun article READY à publier.', null);
    }

    var result = publishArticleById(ready[0].ID);
    result.remaining = ready.length - 1;
    if (result.remaining > 0) {
      logInfo('publish_next', result.remaining + ' article(s) READY restant(s), non traités', {
        total: ready.length
      });
    }
    alertOrLog(formatPublishReport(result));
    return result;
  } catch (e) {
    var message = redact(String(e && e.message ? e.message : e));
    logError('publish_next', message, {});
    alertOrLog('Publication : ÉCHEC\n\n' + message);
    return failure('UNEXPECTED', message, null);
  }
}

/* -------------------------------------------------------------------------- */
/* Noyau                                                                      */
/* -------------------------------------------------------------------------- */

/** Point d'entrée testable : publie l'article identifié par son ID. */
function publishArticleById(id) {
  return publishArticle(findArticleById(id));
}

/**
 * Pipeline de publication d'un article.
 *
 * @param {Object} article ligne `Articles` (lue par en-tête)
 * @param {{lockWaitMs?:number}} [options]
 * @return {Object} résultat structuré (jamais d'exception)
 */
function publishArticle(article, options) {
  var opts = options || {};
  var waitMs = opts.lockWaitMs === undefined ? PUBLISH_LOCK_MS : opts.lockWaitMs;

  if (!article || !article.ID) {
    return failure('NO_ARTICLE', 'Aucun article à publier (ligne absente ou sans ID).', article);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    // Publication concurrente : on ne continue pas, on ne modifie aucune ligne.
    logWarning('publish', 'Publication ignorée : une publication est déjà en cours', {
      articleId: article.ID,
      slug: article.SLUG,
      status: article.STATUS
    });
    return failure('LOCKED',
      'Une publication est déjà en cours. Aucune action.', article);
  }

  try {
    return runPublishPipeline(article.ID, opts);
  } catch (e) {
    // Filet de sécurité : une exception inattendue ne doit jamais laisser la
    // ligne figée en PUBLISHING, ni faire fuiter un détail sensible.
    var message = redact(String(e && e.message ? e.message : e));
    try {
      markError(article.ID, message);
    } catch (writeError) {
      console.error('Impossible de marquer ERROR : ' + redact(String(writeError && writeError.message)));
    }
    logError('publish', message, { articleId: article.ID, slug: article.SLUG });
    return failure('UNEXPECTED', message, article, { status: STATUS.ERROR });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Enchaîne les étapes sous verrou. L'ID est relu depuis la feuille à chaque
 * étape qui en a besoin : aucune donnée périmée n'est réutilisée.
 */
function runPublishPipeline(id, opts) {
  var article = findArticleById(id);
  if (!article) return failure('NO_ARTICLE', 'Ligne introuvable : ' + id, null);

  /* --- 0. Refus de republication --------------------------------------- */
  if (publishBlockedStatuses().indexOf(article.STATUS) !== -1) {
    var blocked = 'Statut « ' + article.STATUS + ' » : publication déjà engagée ou ' +
      'terminée. Repassez la ligne en READY pour publier à nouveau.';
    logWarning('publish', blocked, {
      articleId: id, slug: article.SLUG, status: article.STATUS
    });
    return failure('REPUBLISH_BLOCKED', blocked, article);
  }

  var originStatus = article.STATUS || STATUS.DRAFT;

  /* --- 1. PUBLISHING ---------------------------------------------------- */
  markPublishing(id);
  article = findArticleById(id);

  /**
   * Date de publication :JJJJ-MM-JJ (format exigé par le moteur, code R3a).
   * Une date déjà posée est CONSERVÉE : c'est elle qui rend la republication
   * idempotente (le HTML rendu ne doit pas changer d'un jour à l'autre).
   */
  var publishedAt = String(article.PUBLISHED_AT || '').trim() || toIsoDate();

  /* --- 2. Gabarit (lecture seule, source de vérité = dépôt) ------------- */
  var template = loadArticleTemplate();
  if (!template.ok) {
    return failToError(id, article, 'TEMPLATE', template.error);
  }

  /* --- 3. Rendu + validation du contrat de production ------------------- */
  /**
   * Lignes PUBLIÉES connues du moteur : sans elles, `HREFLANG_LINKS` ne
   * produirait que la langue de l'article et `PREV_LINK`/`NEXT_LINK` resteraient
   * vides — la page serait orpheline de son groupe de traduction. Elles servent
   * aussi au contrôle d'unicité `LANG+SLUG` / `group+lang` du set.
   *
   * Une feuille illisible ne doit pas empêcher une publication : on rend alors
   * sans traductions ni pagination, et on le dit.
   */
  var publishedRows = [];
  try {
    publishedRows = readArticles();
  } catch (readError) {
    logWarning('publish', 'Lignes publiées illisibles : rendu sans traductions ni pagination.', {
      articleId: id,
      slug: article.SLUG,
      details: { error: redact(String(readError && readError.message ? readError.message : readError)) }
    });
    publishedRows = [];
  }

  var render = renderArticleHtml(article, {
    templateHtml: template.html,
    publishedAt: publishedAt,
    published: publishedRows
  });
  if (!render.ok) {
    return failToError(id, article, 'RENDER', describeRenderErrors(render.errors));
  }

  /* --- 4. Verrous d'écriture, APRÈS rendu et validation ----------------- */
  var gate = publishGate();
  if (!gate.ok) {
    restoreStatus(id, originStatus);
    logError('publish', gate.message, {
      articleId: id,
      slug: article.SLUG,
      status: originStatus,
      githubPath: render.path,
      details: { testMode: gate.testMode }
    });
    var result = failure(gate.code, gate.message, article, {
      status: originStatus,
      testMode: gate.testMode,
      githubPath: render.path,
      sitePath: render.sitePath,
      validation: render.validation,
      warnings: render.warnings
    });
    return result;
  }

  /* --- 5. Contents API -------------------------------------------------- */
  var write;
  try {
    write = writeArticleFile(render.path, render.html, article);
  } catch (e) {
    return failToError(id, article, 'GITHUB', redact(String(e && e.message ? e.message : e)));
  }

  /* --- 5b. Index statiques du Blog (articles.json → sitemap) --------------- */
  /**
   * Appelé UNIQUEMENT après le succès de l'écriture de l'article : rien ne
   * n'est indexé si l'article n'est pas publié. L'ordre est imposé par
   * updateIndexesForArticle() : `articles.json` AVANT le sitemap, parce que ce
   * fichier est la source de vérité du hub public — un sitemap en retard ne
   * casse rien de visible, une liste sans l'article le fait.
   *
   * La réconciliation est idempotente : elle est donc exécutée même quand
   * `write.action === 'unchanged'`, un index pouvant être en retard alors que
   * l'article, lui, est à jour.
   *
   * Jamais d'exception (`safeIndexReconcile`). L'article EST publié : seul son
   * référencement statique peut être en retard. En cas d'échec, la colonne
   * ERROR porte un message explicite et la feuille Logs reçoit une entrée
   * ERROR — jamais une succès qui cache le problème dans les DÉTAILS.
   */
  var indexes = safeIndexReconcile(function () {
    return updateIndexesForArticle(article, {
      sitePath: render.sitePath,
      publishedAt: publishedAt
    });
  });
  render.warnings = (render.warnings || []).concat(indexes.warnings || []);

  /* --- 6. PUBLISHED ----------------------------------------------------- */
  // Message d'index : '' si la réconciliation est parfaite, sinon la trace
  // explicite (colonne ERROR + journal ERROR) écrite par markIndexFailure().
  var indexMessage = markIndexFailure('publié', id, {
    SLUG: article.SLUG,
    STATUS: STATUS.PUBLISHED,
    // `article.GITHUB_PATH` est vide tant que la ligne n'est pas écrite : c'est
    // le chemin RÉELLEMENT publié qu'il faut journaliser.
    GITHUB_PATH: write.path
  }, indexes);

  var fields = {
    STATUS: STATUS.PUBLISHED,
    PUBLISHED_AT: publishedAt,
    GITHUB_PATH: write.path,
    GITHUB_SHA: write.sha,
    ERROR: indexMessage
  };
  // Le SHA de commit n'est connu que si un commit vient d'être créé :
  // une republication inchangée ne doit pas effacer la trace précédente.
  if (write.commitSha) fields.GITHUB_COMMIT = write.commitSha;
  updateArticleFields(id, fields);

  var published = findArticleById(id);
  var action = write.action === 'unchanged' ? 'unchanged' : write.action;

  // logSuccess(action, fields) : le message se place DANS l'objet de champs.
  // Un troisième argument serait silencieusement ignoré et l'on perdrait du
  // même coup la trace structurée de l'indexation. Un index en retard ajoute
  // sa propre ligne ERROR (markIndexFailure) : les deux événements sont vrais,
  // ils ne doivent pas être confondus en un seul.
  logSuccess('publish',
    {
      message: indexMessage
        ? 'Article publié, index à réconcilier'
        : (action === 'unchanged' ? 'Article déjà publié, aucun nouveau commit' : 'Article publié'),
      articleId: id,
      slug: article.SLUG,
      status: STATUS.PUBLISHED,
      githubPath: write.path,
      details: {
        action: action,
        sitePath: render.sitePath,
        testMode: false,
        bytes: write.bytes,
        retried: write.retried === true,
        indexed: indexes.indexed,
        indexWrites: indexes.writes,
        warnings: (render.warnings || []).length
      }
    });

  return success(published, {
    code: indexMessage ? 'PUBLISHED_INDEX_PENDING'
      : (action === 'unchanged' ? 'UNCHANGED' : 'PUBLISHED'),
    message: indexMessage
      ? 'Article publié, mais ses index statiques sont en retard : voir la colonne ERROR.'
      : (action === 'unchanged'
        ? 'Article déjà publié à l’identique : aucun nouveau commit.'
        : 'Article publié.'),
    status: STATUS.PUBLISHED,
    publishedAt: publishedAt,
    githubPath: write.path,
    githubSha: write.sha,
    githubCommit: write.commitSha,
    sitePath: render.sitePath,
    bytes: write.bytes,
    retried: write.retried === true,
    indexed: indexes.indexed,
    indexError: indexMessage,
    indexWrites: indexes.writes,
    validation: render.validation,
    warnings: render.warnings
  });
}

/* ==========================================================================
 * D5 — SUPPRESSION D'UN ARTICLE PUBLIÉ
 * ==========================================================================
 *
 * Cette section est STRICTEMENT SÉPARÉE de la publication (`runPublishPipeline`)
 * et n'en réutilise que trois briques : `selectActiveArticle()` (sélection),
 * `publishGate()` (verrou d'écriture) et `success()`/`failure()` (résultat).
 *
 * `publishArticle()` n'est PAS modifié. Aucun de ses chemins n'est réutilisé
 * pour la suppression : elle ne rend pas de HTML, ne lit pas de gabarit et
 * surtout ne crée aucun état transitoire — il n'existe volontairement pas de
 * statut `DELETING`, donc aucune fenêtre pendant laquelle la ligne pourrait
 * être laissée figée par une exception.
 *
 * ORDRE IMPOSÉ (invariant central de la fonctionnalité) :
 *   validation unique → identité → verrou → assertWritesAllowed()
 *   → GET frais → égalité des SHA → articles.json → sitemap
 *   → DELETE de l'article → état de la ligne → résultat → journal.
 *
 * `articles.json` est retiré AVANT le sitemap, comme en publication : c'est la
 * source de vérité du hub public, donc le retrait le plus visible.
 *
 * Pourquoi le fichier article est supprimé EN DERNIER : si une écriture d'index
 * échoue après le DELETE, l'index est en retard alors que le fichier est déjà
 * absent — état réparable par republication. L'inverse (index à jour, fichier
 * encore présent) laisserait un lien mort visible du public, plus difficile à
 * détecter et à corriger. C'est le seul point où la suppression est
 * volontairement symétrique de la publication, et donc l'inverse.
 *
 * ÉCHEC D'INDEX : la suppression va au bout (le fichier est supprimé), mais la
 * colonne ERROR de la ligne n'est PAS remise à zéro — elle porte le message
 * écrit par `markIndexFailure()`, et la feuille Logs reçoit une entrée ERROR.
 * Aucun index en retard n'est jamais réduit à un simple avertissement.
 *
 * AUCUN retour en arrière : ce qui a été écrit reste écrit. L'état d'échec
 * observable est `STATUS = ERROR` avec les champs GitHub CONSERVÉS, afin que
 * l'opérateur puisse diagnostiquer (et ré-essayer) sans avoir perdu le SHA.
 */

/** Statut unique exigé pour pouvoir supprimer. */
var DELETE_REQUIRED_STATUS = 'PUBLISHED';

/**
 * Point d'entrée unique de la suppression, appelé par Code.gs.
 *
 * @param {string} id ID de la ligne (jamais un numéro de ligne, jamais un chemin)
 * @return {Object} résultat `success()`/`failure()`
 */
function deleteArticleById(id) {
  var wanted = String(id === null || id === undefined ? '' : id).trim();
  if (!wanted) {
    return failure('NO_ARTICLE', 'Aucun article sélectionné (identifiant absent).', null);
  }
  return deleteArticle(wanted);
}

/**
 * Supprime l'article identifié par `id`.
 *
 * @param {string} id
 * @return {Object} résultat normalisé
 */
function deleteArticle(id) {
  var waitMs = DELETE_LOCK_MS;

  /* --- 1. Lecture de la ligne ------------------------------------------- */
  var article = findArticleById(id);
  if (!article) return failure('NO_ARTICLE', 'Ligne introuvable : ' + id, null);

  /* --- 2. Verrou de script ---------------------------------------------- */
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    // Suppression concurrente : aucune ligne n'est touchée, aucune requête.
    logDeleteEvent(LEVEL.WARNING, 'Suppression ignorée : une opération est déjà en cours', {
      articleId: article.ID,
      slug: article.SLUG,
      status: article.STATUS,
      githubPath: article.GITHUB_PATH
    });
    return failure('LOCK_BUSY',
      'Une opération est déjà en cours. Aucune action.', article);
  }

  try {
    return runDeletePipeline(article.ID);
  } catch (e) {
    // Filet de sécurité : une exception inattendue ne doit ni laisser un commit
    // à moitié supprimé ni masquer la cause. La ligne passe en ERROR, les champs
    // GitHub sont CONSERVÉS (le diagnostic exige le SHA d'origine).
    var message = redact(String(e && e.message ? e.message : e));
    try {
      markDeleteError(article.ID, message);
    } catch (writeError) {
      console.error('Impossible de marquer ERROR : ' + redact(String(writeError && writeError.message)));
    }
    logDeleteEvent(LEVEL.ERROR, message, {
      articleId: article.ID,
      slug: article.SLUG,
      status: STATUS.ERROR,
      githubPath: article.GITHUB_PATH
    });
    return failure('UNEXPECTED', message, article, { status: STATUS.ERROR });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Chaîne d'opérations sous verrou. La ligne est RELUE au début : la validation
 * porte sur l'état courant, jamais sur celui présenté dans le dialogue.
 */
function runDeletePipeline(id) {
  /* --- 1. Ligne présente et cohérente ----------------------------------- */
  var article = findArticleById(id);
  if (!article) return failure('NO_ARTICLE', 'Ligne introuvable : ' + id, null);

  /* --- 2. Contrôles de champ (chemin, SHA, catégorie, slug) ------------- */
  /**
   * Les CHAMPS passent avant le STATUT, et c'est délibéré.
   *
   * Après une suppression réussie, la ligne repasse READY et `GITHUB_PATH`
   * est vidé : la refuser sur `MISSING_PATH` (« cette ligne est déjà
   * réconciliée, il n'y a rien à supprimer ») est plus juste que
   * `NOT_PUBLISHED`, qui laisserait croire que la ligne attend encore sa
   * première publication. L'ordre ne coûte rien : ces contrôles sont purely
   * structurels, ils n'effectuent AUCUN appel GitHub, et ils sont vrais pour
   * toute ligne PUBLISHED cohérente comme faux pour toute ligne falsifiée.
   */
  var check = checkDeletableFields(article);
  if (!check.ok) {
    logDeleteEvent(LEVEL.WARNING, check.message, {
      articleId: id, slug: article.SLUG, status: article.STATUS,
      githubPath: article.GITHUB_PATH
    });
    return failure(check.code, check.message, article);
  }
  var identity = check.identity;

  /* --- 3. Statut : PUBLISHED exigé -------------------------------------- */
  if (String(article.STATUS || '') !== DELETE_REQUIRED_STATUS) {
    var blocked = 'Statut « ' + (article.STATUS || '(vide)') + ' » : seuls les articles ' +
      DELETE_REQUIRED_STATUS + ' peuvent être supprimés. Aucun appel GitHub.';
    logDeleteEvent(LEVEL.WARNING, blocked, {
      articleId: id, slug: article.SLUG, status: article.STATUS,
      githubPath: identity.path
    });
    return failure('NOT_PUBLISHED', blocked, article);
  }

  /* --- 4. Verrou d'écriture, TOUT AU DEBUT ------------------------------ */
  var gate = publishGate();
  if (!gate.ok) {
    // Un refus de verrou n'est PAS une erreur d'article : la ligne reste
    // PUBLISHED, donc supprimable plus tard. Aucun appel GitHub n'a eu lieu.
    logDeleteEvent(LEVEL.ERROR, gate.message, {
      articleId: id,
      slug: article.SLUG,
      status: DELETE_REQUIRED_STATUS,
      githubPath: identity.path
    });
    return failure(gate.code, gate.message, article, {
      status: DELETE_REQUIRED_STATUS,
      githubPath: identity.path,
      testMode: gate.testMode
    });
  }

  /* --- 5. Lecture fraîche du dépôt + égalité des SHA --------------------- */
  /**
   * Le SHA enregistré est-il encore celui du fichier EN LIGNE ?
   *
   * C'est le garde-fou le plus important de toute la fonctionnalité : sans lui,
   * un operator qui republie entre-temps verrait sa nouvelle version supprimée
   * alors que la feuille décrit l'ancienne. On compare donc SHA à SHA et l'on
   * refuse si le dépôt a bougé.
   */
  var remote = null;
  try {
    remote = getFile(identity.path);
  } catch (e) {
    return failDeleteToError(id, article, 'REMOTE_READ',
      redact(String(e && e.message ? e.message : e)));
  }
  if (!remote) {
    // Exigence explicite : le fichier doit EXISTER avant toute écriture. Une
    // suppression « au cas où » d'un fichier déjà absent produirait des
    // retraits d'index hasardeux pour rien ; l'opérateur doit d'abord
    // constater l'écart. Aucune écriture n'est faite dans ce cas.
    var notFound = 'Fichier distant absent : ' + identity.path +
      '. Aucune écriture. Vérifiez que la ligne correspond bien à un article publié.';
    logDeleteEvent(LEVEL.ERROR, notFound, {
      articleId: id, slug: article.SLUG, status: article.STATUS, githubPath: identity.path
    });
    return failure('REMOTE_NOT_FOUND', notFound, article, {
      githubPath: identity.path, indexed: null, indexWrites: 0
    });
  }
  if (String(remote.sha || '') !== identity.sha) {
    var drift = 'SHA distant différent de celui enregistré (attendu ' +
      identity.sha.slice(0, 12) + ', trouvé ' + String(remote.sha).slice(0, 12) +
      '). Article modifié depuis sa publication : suppression refusée pour ' +
      'ne pas écraser une version plus récente.';
    logDeleteEvent(LEVEL.ERROR, drift, {
      articleId: id, slug: article.SLUG, status: article.STATUS, githubPath: identity.path
    });
    return failure('SHA_DRIFT', drift, article, {
      githubPath: identity.path, indexed: null, indexWrites: 0
    });
  }

  /* --- 6. Index statiques : articles.json → sitemap ----------------------- */
  var indexes = safeIndexReconcile(function () {
    return removeIndexesForArticle(article, {
      href: identity.sitePath,
      categorySlug: identity.categorySlug,
      categoryName: identity.categoryName,
      slug: article.SLUG
    });
  });

  /* --- 7. Suppression du fichier article (EN DERNIER) ------------------- */
  var deleted = null;
  try {
    deleted = deleteFile({
      path: identity.path,
      sha: identity.sha,
      message: deleteCommitMessage(article)
    });
  } catch (e) {
    // Les index peuvent avoir été nettoyés : il n'y a pas de retour en arrière.
    // La ligne passe en ERROR, champs GitHub CONSERVÉS, afin que l'opérateur
    // puisse relancer une suppression (après remise en PUBLISHED) ou, mieux,
    // vérifier ce qui a déjà été retiré.
    var wiped = (indexes.warnings || []).map(function (w) { return w.code; });
    if (wiped.length) {
      indexes.warnings.push({
        code: 'INDEX_ALREADY_CLEANED',
        message: 'Des index avaient déjà été nettoyés avant l\'échec de la suppression : ' +
          'vérifiez leur état avant de relancer.'
      });
    }
    return failDeleteToError(id, article, 'DELETE_FAILED',
      redact(String(e && e.message ? e.message : e)), indexes);
  }

  /* --- 8. Ligne remise à zéro ------------------------------------------ */
  /**
   * PUBLISHED → READY, et les trois champs GitHub sont VIDÉS.
   *
   * `PUBLISHED_AT` est CONSERVÉ : c'est l'historique de première publication, il
   * ne décrit pas le fichier distant. `TITLE`, `CONTENT` et les métadonnées SEO
   * sont conservés : la ligne redevient un brouillon publiable, pas une ligne
   * vide. `ERROR` n'est remis à zéro que si les index ont été réconciliés :
   * sinon il porte le message explicite écrit par markIndexFailure(), sinon un
   * index en retard serait invisible dans la feuille.
   */
  var deleteIndexMessage = markIndexFailure('supprimé', id, article, indexes);
  updateArticleFields(id, {
    STATUS: STATUS.READY,
    GITHUB_PATH: '',
    GITHUB_SHA: '',
    GITHUB_COMMIT: '',
    ERROR: deleteIndexMessage
  });

  var after = findArticleById(id) || article;

  /* --- 9. Journal -------------------------------------------------------- */
  /**
   * La suppression RÉUSSIT toujours ici : le DELETE a eu lieu. Le niveau reste
   * donc SUCCESS, et l'échec d'index — qui est un AUTRE événement — porte sa
   * propre ligne ERROR écrite par markIndexFailure(). Deux événements, deux
   * lignes : les confondre en un seul « article supprimé » ferait passer une
   * réconciliation ratée pour un succès complet.
   */
  logDeleteEvent(LEVEL.SUCCESS, 'Article supprimé du dépôt', {
    articleId: id,
    slug: article.SLUG,
    status: STATUS.READY,
    githubPath: identity.path,
    details: {
      sitePath: identity.sitePath,
      testMode: false,
      categoryIndexWrites: indexes.categoryIndex.changed === true,
      hubWrites: indexes.hub.changed === true,
      sitemapWrites: indexes.sitemap.changed === true,
      articlesIndexWrites: indexes.articlesIndex.changed === true,
      indexWrites: indexes.writes,
      indexed: indexes.indexed,
      indexError: deleteIndexMessage,
      categoryTotal: typeof indexes.categoryIndex.count === 'number' ? indexes.categoryIndex.count : -1,
      commitSha: deleted.commitSha,
      warnings: (indexes.warnings || []).length
    }
  });

  /* --- 10. Résultat ------------------------------------------------------ */
  var warnings = indexes.warnings || [];
  return success(after, {
    code: deleteIndexMessage ? 'DELETED_INDEX_PENDING' : 'DELETED',
    message: deleteIndexMessage
      ? 'Article supprimé, mais ses index statiques sont en retard : voir la colonne ERROR.'
      : (warnings.length
        ? 'Article supprimé, mais ' + warnings.length + ' index(s) à vérifier.'
        : 'Article supprimé du dépôt et des index.'),
    status: STATUS.READY,
    githubPath: '',
    githubSha: '',
    githubCommit: '',
    sitePath: identity.sitePath,
    categoryIndex: indexes.categoryIndex,
    hub: indexes.hub,
    sitemap: indexes.sitemap,
    articlesIndex: indexes.articlesIndex,
    indexed: indexes.indexed,
    indexError: deleteIndexMessage,
    indexWrites: indexes.writes,
    removedCommit: deleted.commitSha,
    warnings: warnings
  });
}

/**
 * Contrôles de champ, SANS aucun appel GitHub.
 *
 * Séparés de `runDeletePipeline` pour être réutilisables par le dialogue de
 * confirmation : celui-ci doit pouvoir afficher un chemin calculé de façon
 * fiable, sans dupliquer les règles.
 *
 * Le contrôle d'IDENTITÉ est le cœur : `GITHUB_PATH` doit être exactement le
 * chemin DÉRIVÉ de LANG + SLUG. C'est ce qui empêche qu'une valeur de feuille
 * falsifiée (ou un reste de copier-coller) ne désigne le fichier d'un autre
 * article. La CATEGORY est contrôlée séparément et ne participe PAS au chemin :
 * elle ne sert qu'aux index.
 *
 * @return {{ok:boolean, code?:string, message?:string, identity?:Object}}
 */
function checkDeletableFields(article) {
  if (!article || !article.ID) {
    return { ok: false, code: 'NO_ARTICLE', message: 'Ligne absente ou sans ID.' };
  }

  var storedPath = String(article.GITHUB_PATH === null || article.GITHUB_PATH === undefined ? '' : article.GITHUB_PATH).trim();
  var storedSha = String(article.GITHUB_SHA === null || article.GITHUB_SHA === undefined ? '' : article.GITHUB_SHA).trim();
  var slug = String(article.SLUG === null || article.SLUG === undefined ? '' : article.SLUG).trim();
  var lang = String(article.LANG === null || article.LANG === undefined ? '' : article.LANG).trim();

  if (!storedPath) {
    return {
      ok: false, code: 'MISSING_PATH',
      message: 'GITHUB_PATH vide : rien à supprimer. Repassez la ligne en PUBLISHED après republication.'
    };
  }
  if (!storedSha) {
    return {
      ok: false, code: 'MISSING_SHA',
      message: 'GITHUB_SHA vide : suppression impossible (le SHA protège d’une suppression d’un fichier non publié).'
    };
  }
  if (!isValidSlug(slug)) {
    return {
      ok: false, code: 'INVALID_SLUG',
      message: 'SLUG invalide : « ' + slug + ' ». Aucune suppression.'
    };
  }

  // LANG est la moitié de l'identité du fichier : les articles sont publiés dans
  // `blog/{LANG}/{SLUG}.html`. Elle est contrôlée AVANT la catégorie, parce que
  // c'est elle qui décide du chemin à comparer à GITHUB_PATH.
  if (!lang) {
    return {
      ok: false, code: 'MISSING_LANG',
      message: 'LANG vide : le chemin du fichier ne peut pas être reconstitué. Aucune suppression.'
    };
  }
  if (!isSupportedLang(lang)) {
    return {
      ok: false, code: 'INVALID_LANG',
      message: 'LANG non gérée : « ' + lang + ' » (attendu ' + APP.SUPPORTED_LANGS.join(', ') + '). Aucune suppression.'
    };
  }

  // Catégorie obligatoire, et EXIGÉE : une catégorie absente est un refus
  // (`MISSING_CATEGORY`), jamais une création. Elle est distinguée de la
  // catégorie non mappée (`UNKNOWN_CATEGORY`) parce que les deux erreurs n'appelent
  // pas la même correction de l'opérateur. Elle ne participe PLUS au chemin :
  // elle ne sert qu'aux index (compteurs et carte de catégorie).
  var categoryName = String(article.CATEGORY === null || article.CATEGORY === undefined ? '' : article.CATEGORY).trim();
  if (!categoryName) {
    return {
      ok: false, code: 'MISSING_CATEGORY',
      message: 'CATEGORY vide : la catégorie est obligatoire pour l’index. Aucune suppression.'
    };
  }

  // Catégorie connue → slug de catégorie. Une catégorie inconnue est un refus,
  // jamais une création (même politique que resolveCategory()).
  var category;
  try {
    category = resolveCategory(categoryName);
  } catch (e) {
    return {
      ok: false, code: 'UNKNOWN_CATEGORY',
      message: redact(String(e && e.message ? e.message : e))
    };
  }

  var expectedPath = blogPath(lang, slug);
  if (storedPath !== expectedPath) {
    return {
      ok: false, code: 'PATH_MISMATCH',
      message: 'GITHUB_PATH incohérent : « ' + storedPath + ' » alors que LANG=' +
        lang + ' et SLUG=' + slug + ' donnent « ' + expectedPath +
        ' ». Aucune suppression (protection contre une ligne falsifiée).'
    };
  }

  // Dernière barrière, purely structurelle : refuse hub, sitemap, gabarit,
  // index de catégorie, répertoire, traversée et jokers.
  try {
    validateArticleFilePath(storedPath);
  } catch (e) {
    return {
      ok: false, code: 'INVALID_PATH',
      message: redact(String(e && e.message ? e.message : e))
    };
  }

  return {
    ok: true,
    identity: {
      path: expectedPath,
      sha: storedSha,
      sitePath: sitePath(lang, slug),
      lang: lang,
      categorySlug: category.slug,
      categoryName: category.name,
      slug: slug,
      publishedAt: String(article.PUBLISHED_AT || '')
    }
  };
}

/**
 * Article situé sur la ligne sélectionnée, pour SUPPRESSION.
 *
 * Garde DÉDIÉ, et non réutilisation de `selectActiveArticle()` : ce dernier ne
 * connaît que `getActiveCell()`, qui renvoie la cellule active même quand
 * l'opérateur a sélectionné trois lignes. Une suppression est irréversible, et
 * interpréter une plage de trois lignes comme « le premier article » serait
 * exactement le type de choix non confirmé qu'un garde doit interdire. Le plan
 * D5.6 l'impose, l'invariant 1 avec lui (« une seule ligne sélectionnée,
 * exactement »).
 *
 * On lit donc la PLAGE (`getActiveRange().getNumRows()`), jamais la cellule
 * seule, et chaque refus porte un code distinct pour que l'opérateur sache
 * quoi corriger :
 *
 *   WRONG_SHEET      la feuille active n'est pas `Articles`
 *   EMPTY_SELECTION  aucune plage sélectionnée
 *   MULTIPLE_ROWS    plus d'une ligne sélectionnée
 *   HEADER_ROW       la ligne d'en-tête est ciblée
 *   NO_ARTICLE       la ligne sélectionnée ne contient aucun article
 *   NOT_PUBLISHED    la ligne n'est pas `PUBLISHED`
 *
 * La ligne d'en-tête est doublement protégée : par `getRow() >= 2`, et par le
 * contrôle de statut (un en-tête contient la chaîne littérale `STATUS`, jamais
 * `PUBLISHED`). La redondance est délibérée.
 *
 * AUCUN appel GitHub ici : ce garde ne fait que lire la feuille.
 *
 * @return {{ok:boolean, code?:string, error?:string, article?:Object}}
 */
function selectArticleForDeletion() {
  var sheet = null;
  try {
    sheet = SpreadsheetApp.getActiveSheet();
  } catch (e) {
    sheet = null;
  }
  if (!sheet || String(sheet.getName()) !== SHEETS.ARTICLES) {
    return {
      ok: false,
      code: 'WRONG_SHEET',
      error: 'Sélectionnez une ligne de la feuille « ' + SHEETS.ARTICLES + ' ».'
    };
  }

  // La PLAGE, pas la cellule : c'est la seule façon de distinguer une cellule
  // d'une sélection de plusieurs lignes.
  var range = null;
  try {
    range = sheet.getActiveRange();
  } catch (e) {
    range = null;
  }
  if (!range) {
    return {
      ok: false,
      code: 'EMPTY_SELECTION',
      error: 'Aucune sélection : cliquez sur la ligne de l’article à supprimer.'
    };
  }

  var numRows = Number(range.getNumRows());
  if (!(numRows >= 1)) {
    return {
      ok: false,
      code: 'EMPTY_SELECTION',
      error: 'Sélection vide : cliquez sur la ligne de l’article à supprimer.'
    };
  }
  if (numRows > 1) {
    return {
      ok: false,
      code: 'MULTIPLE_ROWS',
      error: numRows + ' lignes sélectionnées : la suppression porte sur un seul ' +
        'article. Sélectionnez uniquement la ligne voulue.'
    };
  }

  var row = Number(range.getRow());
  if (!(row >= 2)) {
    return {
      ok: false,
      code: 'HEADER_ROW',
      error: 'Ligne d\'en-tête sélectionnée : choisissez une ligne d\'article.'
    };
  }

  // Une seule lecture, une seule vérité : `readArticles()` pilote par l'en-tête,
  // comme le reste de l'application. `__row` identifie la ligne physique.
  var rows = readArticles();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].__row === row) {
      var article = rows[i];
      if (String(article.STATUS || '') !== DELETE_REQUIRED_STATUS) {
        return {
          ok: false,
          code: 'NOT_PUBLISHED',
          error: 'Statut « ' + (article.STATUS || '(vide)') + ' » : seuls les articles ' +
            DELETE_REQUIRED_STATUS + ' peuvent être supprimés.',
          article: article
        };
      }
      return { ok: true, article: article };
    }
  }

  return {
    ok: false,
    code: 'NO_ARTICLE',
    error: 'Aucune ligne d\'article à la ligne ' + row + '.'
  };
}

/**
 * Article situé sur la ligne sélectionnée, VÉRIFIÉ supprimable.
 *
 * Enchaîne le garde de sélection DEDIE (`selectArticleForDeletion()`) puis les
 * contrôles de CHAMPS et d'identité. Ces derniers n'effectuent AUCUN appel
 * GitHub : ouvrir le dialogue ne doit rien déclencher.
 *
 * @return {{ok:boolean, code?:string, error?:string, article?:Object, identity?:Object}}
 */
function selectActivePublishedArticle() {
  var picked = selectArticleForDeletion();
  if (!picked.ok) return { ok: false, code: picked.code, error: picked.error };

  var check = checkDeletableFields(picked.article);
  if (!check.ok) return { ok: false, code: check.code, error: check.message };

  return { ok: true, article: picked.article, identity: check.identity };
}

/**
 * Journal du flux de suppression.
 *
 * `logWarning()` et `logError()` n'acceptent que `details` : ils déposent donc
 * `githubPath` dans la colonne DETAILS (index 8) et laissent la colonne
 * GITHUB_PATH (index 6) VIDE. Or c'est précisément cette colonne qui permet,
 * depuis le seul journal, de retrouver le fichier concerné — sans elle, un
 * échec de suppression n'était pas rattachable à un article. On appelle donc
 * `logEvent()` directement, en s'appuyant sur le même objet que
 * `logSuccess()` ; `Logger.gs` n'est pas modifié.
 *
 * Le message est systématiquement passé par `redact()` : aucune trace de jeton
 * ni de donnée sensible ne doit atteindre la feuille Logs.
 *
 * @param {string} level LEVEL.INFO | LEVEL.SUCCESS | LEVEL.WARNING | LEVEL.ERROR
 * @param {string} message
 * @param {{articleId?:string, slug?:string, status?:string,
 *          githubPath?:string, details?:Object}} [fields]
 */
function logDeleteEvent(level, message, fields) {
  var f = fields || {};
  try {
    logEvent({
      level: level,
      action: 'delete',
      articleId: f.articleId,
      slug: f.slug,
      status: f.status,
      githubPath: f.githubPath,
      message: redact(String(message === null || message === undefined ? '' : message)),
      details: f.details
    });
  } catch (e) {
    // Un journal ne doit JAMAIS interrompre une suppression.
    console.error('Échec journalisation (delete) : ' + redact(String(e && e.message ? e.message : e)));
  }
}

/** Message de commit déterministe : deux exécutions donnent le même texte. */
function deleteCommitMessage(article) {
  return 'Suppression : ' + String((article && article.SLUG) || (article && article.ID) || 'article');
}

/** PUBLISHED → ERROR, en conservant les champs GitHub (diagnostic). */
function markDeleteError(id, message) {
  updateArticleFields(id, { STATUS: STATUS.ERROR, ERROR: redact(String(message || '')) });
}

/** Échec contrôlé de la suppression : ligne en ERROR, journal, résultat. */
function failDeleteToError(id, article, code, message, indexes) {
  var safe = redact(String(message || ''));
  markDeleteError(id, safe);
  logDeleteEvent(LEVEL.ERROR, safe, {
    articleId: id,
    slug: article && article.SLUG,
    status: STATUS.ERROR,
    githubPath: article && article.GITHUB_PATH
  });
  var failed = failure(code, safe, article, {
    status: STATUS.ERROR,
    indexed: indexes ? (indexes.ok === true ? true : false) : null,
    indexWrites: indexes ? indexes.writes : 0,
    warnings: (indexes && indexes.warnings) || []
  });
  var fresh = findArticleById(id);
  if (fresh) failed.status = fresh.STATUS;
  return failed;
}

/**
 * Confirmation explicite : « Annuler » par défaut.
 *
 * Le dialogue ne propose JAMAIS un champ modifiable : le chemin affiché est
 * celui qui sera supprimé, et il ne peut pas être remplacé.
 *
 * @param {string} id
 */
function showDeleteArticleDialog(id) {
  var wanted = String(id === null || id === undefined ? '' : id).trim();
  if (!wanted) return { ok: false, error: 'Aucun article sélectionné.' };

  var article = findArticleById(wanted);
  if (!article) return { ok: false, error: 'Ligne introuvable : ' + wanted };

  // Même validation que la confirmation, mais SANS écriture : le dialogue ne
  // doit jamais valider une suppression qu'il ne pourrait pas exécuter.
  var check = checkDeletableFields(article);
  if (!check.ok) return { ok: false, error: check.message };
  if (String(article.STATUS || '') !== DELETE_REQUIRED_STATUS) {
    return {
      ok: false,
      error: 'Statut « ' + (article.STATUS || '(vide)') + ' » : seuls les articles ' +
        DELETE_REQUIRED_STATUS + ' peuvent être supprimés.'
    };
  }

  var view = renderDeleteDialogHtml(article, check.identity);
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(view).setWidth(520).setHeight(340),
    'Supprimer l’article : ' + (article.TITLE || article.SLUG)
  );
  return { ok: true, articleId: article.ID, path: check.identity.path };
}

/**
 * HTML du dialogue de confirmation.
 * Function PUR : toute donnée de la feuille est échappée.
 */
function renderDeleteDialogHtml(article, identity) {
  return [
    '<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;padding:4px">',
    '<p style="margin:0 0 10px"><b>' + escHtml(article.TITLE || article.SLUG) + '</b></p>',
    '<p style="margin:0 0 12px;color:#666;font-size:12px">',
    escHtml(identity.categoryName),
    identity.publishedAt ? ' · publié le ' + escHtml(identity.publishedAt) : '',
    '</p>',
    '<p style="margin:0 0 10px"><b>Cette suppression est définitive.</b></p>',
    '<p style="margin:0 0 10px">Le fichier suivant sera supprimé du dépôt, ',
    'ainsi que sa référence dans le hub du Blog (articles.json) et le sitemap.</p>',
    '<p style="margin:0 0 4px">Fichier :</p>',
    '<code style="display:block;font-family:monospace;background:#f4f4f5;padding:6px;',
    'word-break:break-all;border-radius:3px">',
    escHtml(identity.path),
    '</code>',
    '<p style="margin:8px 0 14px;color:#666;font-size:12px">SHA : ',
    escHtml(identity.sha), '</p>',
    '<p style="margin:0 0 14px;color:#b45309">',
    'Cette action est irréversible. Il n’y a pas de retour arrière.',
    '</p>',
    '<div style="text-align:right">',
    '<button type="button" id="cancel" autofocus ',
    'style="margin-right:8px;padding:6px 14px">Annuler</button>',
    '<button type="button" id="confirm" ',
    'style="padding:6px 14px;color:#fff;background:#b91c1c;border:1px solid #b91c1c;',
    'border-radius:3px;cursor:pointer">SUPPRIMER DÉFINITIVEMENT</button>',
    '</div>',
    // Zone de résultat : SEUL canal de retour visible du dialogue. Ni `alert()`
    // (avalé par le sandbox de l'iframe HtmlService) ni un libellé de bouton ne
    // permettent à l'opérateur de lire un refus (code + message).
    '<div id="result" role="status" aria-live="polite" style="margin-top:12px"></div>',
    '<script>',
    'function cancelDelete(){google.script.host.close()}',
    'var bConfirm=document.getElementById("confirm");',
    'var bCancel=document.getElementById("cancel");',
    'var bResult=document.getElementById("result");',
    'var D5_COLORS={busy:["#b45309","#fffbeb"],ok:["#15803d","#f0fdf4"],ko:["#b91c1c","#fef2f2"]};',
    'function d5Say(kind,text){',
    'var c=D5_COLORS[kind];',
    'bResult.textContent=text;',
    'bResult.style.cssText="margin-top:12px;padding:8px;border-radius:3px;',
    'white-space:pre-wrap;word-break:break-word;color:"+c[0]+";background:"+c[1]+";',
    'border:1px solid "+c[0]+";";',
    // Le dialogue ne se referme jamais tout seul : « Fermer » force une lecture.
    'bCancel.textContent="Fermer";',
    'try{if(bResult.scrollIntoView)bResult.scrollIntoView()}catch(e){}',
    '}',
    'bCancel.addEventListener("click",cancelDelete);',
    'bConfirm.addEventListener("click",function(){',
    'var b=this;',
    'if(b.disabled)return;',
    // Verrou anti-double soumission : le bouton ne revient jamais actif, que la
    // suppression réussisse ou échoue. Aucune nouvelle tentative sans diagnostic.
    'b.disabled=true;',
    'd5Say("busy","Suppression en cours…");',
    'google.script.run.withSuccessHandler(function(r){',
    'if(r&&r.ok){',
    'd5Say("ok",r.message?"Suppression : RÉUSSIE\\n"+r.message:"Suppression : RÉUSSIE");',
    'return;',
    '}',
    // REFUS : le code et le message sont affichés, jamais masqués ni remplacés.
    'd5Say("ko","Suppression : ÉCHEC ("+(r&&r.code?r.code:"ERREUR")+")\\n"',
    '+(r&&r.message?r.message:"Aucun détail renvoyé par le serveur."));',
    '}).withFailureHandler(function(e){',
    'var msg=e&&e.message?String(e.message):String(e);',
    // L'exception est à la fois affichée ET tracée : plus rien n'est avalé.
    'console.error("[D5 delete] "+msg);',
    'd5Say("ko","Suppression : ÉCHEC (exception)\\n"+msg);',
    // Pas de `;` ici : la chaîne doit rester ouverte sur `.deleteArticleById(...)`.
    '})',
    '.deleteArticleById(' + JSON.stringify(String(article.ID)) + ');});',
    '</script>',
    '</div>'
  ].join('');
}

/**
 * Compte rendu lisible de la suppression.
 * @param {Object} result
 * @return {string}
 */
function formatDeleteReport(result) {
  if (!result) return 'Suppression : aucun résultat.';

  var lines = [];
  lines.push(result.ok ? 'Suppression : RÉUSSIE' : 'Suppression : ÉCHEC');
  lines.push('');
  if (result.title || result.slug) {
    lines.push('Article   : ' + (result.title || result.slug) +
      (result.slug ? ' (' + result.slug + ')' : ''));
  }
  if (result.statusBefore) lines.push('Statut    : ' + result.statusBefore + ' → ' + result.status);
  if (result.message) lines.push('Détail    : ' + result.message);
  if (result.sitePath) lines.push('URL       : ' + buildSiteUrl(result.sitePath));

  if (result.ok) {
    if (result.indexed === false) {
      lines.push('Index     : À VÉRIFIER (fichier supprimé, un index est en retard)');
    } else {
      lines.push('Index     : ' + (result.indexWrites || 0) + ' index mis à jour');
    }
    if (result.removedCommit) lines.push('Commit    : ' + result.removedCommit.slice(0, 12));
  }

  if (result.warnings && result.warnings.length) {
    lines.push('', 'Avertissements :');
    result.warnings.slice(0, 5).forEach(function (w) {
      lines.push('- ' + ((w.code ? w.code + ' ' : '') + w.message));
    });
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Sélection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Article situé sur la ligne active de la feuille `Articles`.
 * @return {{ok:boolean, article?:Object, error?:string}}
 */
function selectActiveArticle() {
  var sheet = null;
  try {
    sheet = SpreadsheetApp.getActiveSheet();
  } catch (e) {
    sheet = null;
  }
  if (!sheet || String(sheet.getName()) !== SHEETS.ARTICLES) {
    return {
      ok: false,
      error: 'Sélectionnez une ligne de la feuille « ' + SHEETS.ARTICLES + ' ».'
    };
  }

  var row = sheet.getActiveCell().getRow();
  if (!row || row < 2) {
    return { ok: false, error: 'Ligne d’en-tête sélectionnée : choisissez une ligne d’article.' };
  }

  var rows = readArticles();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].__row === row) return { ok: true, article: rows[i] };
  }
  return { ok: false, error: 'Aucune ligne d’article à la ligne ' + row + '.' };
}

/* -------------------------------------------------------------------------- */
/* Verrous d'écriture                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Delegue à assertWritesAllowed() (point d'entrée unique de Github.gs) et
 * traduit le refus en code exploitable. Aucun second chemin d'écriture.
 * @return {{ok:boolean, code?:string, message?:string, testMode:boolean}}
 */
function publishGate() {
  try {
    assertWritesAllowed();
    return { ok: true, testMode: false };
  } catch (e) {
    var raw = String(e && e.message ? e.message : e);
    if (raw === ERR_TEST_MODE) {
      return {
        ok: false,
        code: 'TEST_MODE',
        testMode: true,
        message: 'TEST_MODE=TRUE — mode test : rendu et validation effectués, ' +
          'aucune écriture GitHub. Article NON publié.'
      };
    }
    if (raw === ERR_WRITES_DISABLED) {
      return {
        ok: false,
        code: 'WRITES_DISABLED',
        testMode: false,
        message: 'GITHUB_WRITE_ENABLED=FALSE — écriture fermée. Article NON publié.'
      };
    }
    return { ok: false, code: 'GATE', testMode: false, message: raw };
  }
}

/* -------------------------------------------------------------------------- */
/* Écriture GitHub                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Crée ou met à jour le fichier de l'article via l'API Contents.
 *
 * Idempotence : si le contenu distant est déjà identique, AUCUN commit n'est
 * créé (le SHA existant est réutilisé). En cas de conflit de SHA (409), le
 * fichier est relu et l'écriture retentée une fois, bornée.
 *
 * @return {{action:string, path:string, sha:string, commitSha:string,
 *           bytes:number, retried?:boolean}}
 */
function writeArticleFile(path, content, article) {
  var message = publishCommitMessage(article);
  var existing = getFile(path);

  if (existing && existing.content === content) {
    return {
      action: 'unchanged',
      path: path,
      sha: existing.sha,
      commitSha: '',
      bytes: content.length
    };
  }

  try {
    return createOrUpdate({ path: path, content: content, message: message, sha: existing ? existing.sha : '', action: existing ? 'update' : 'create' });
  } catch (e) {
    if (!isShaConflict(e) || PUBLISH_CONFLICT_RETRIES < 1) throw e;
    return retryAfterConflict(path, content, message);
  }
}

/** Conflit de SHA : le dépôt a bougé entre la lecture et l'écriture. */
function retryAfterConflict(path, content, message) {
  var fresh = getFile(path);
  if (fresh && fresh.content === content) {
    return {
      action: 'unchanged',
      path: path,
      sha: fresh.sha,
      commitSha: '',
      bytes: content.length,
      retried: true
    };
  }
  var written = createOrUpdate({
    path: path,
    content: content,
    message: message,
    sha: fresh ? fresh.sha : '',
    action: fresh ? 'update' : 'create'
  });
  written.retried = true;
  return written;
}

/**
 * SHA d'un fichier, TOUJOURS sous forme de chaîne.
 *
 * L'API GitHub attend `sha` comme un scalaire dans le corps du PUT : passer
 * l'objet renvoyé par `getFile()` (`{path, content, sha}`) sérialiserait cet
 * objet entier dans le JSON et le serveur répondrait 422. Les deux formes sont
 * donc normalisées ici, et une valeur inexploitable est refusée bruyamment
 * plutôt que passée en `undefined` au moment de l'appel réseau.
 *
 * @param {string|{sha:string}|null|undefined} value
 * @return {string} chaîne non vide si le fichier existe, sinon ''
 */
function shaOf(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value.trim();
  // `{sha: ''}` = création (pas de SHA), cas légitime. Un objet SANS propriété
  // `sha` est en revanche une erreur d'appel : elle doit être bruyante ici,
  // et non un `undefined` silencieux dans le corps du PUT.
  if (typeof value === 'object' && typeof value.sha === 'string') return value.sha.trim();
  throw new Error('SHA illisible : "' + String(value && value.path ? value.path : value) + '"');
}

/** Appel unique en écriture, résultat normalisé. */
function createOrUpdate(opt) {
  var res = createOrUpdateFile({
    path: opt.path,
    content: opt.content,
    message: opt.message,
    sha: shaOf(opt.sha)
  });
  return {
    action: opt.action,
    path: res.path || opt.path,
    sha: res.sha,
    commitSha: res.commitSha,
    bytes: opt.content.length
  };
}

/** Le message d'erreur correspond-il à un conflit de SHA (HTTP 409) ? */
function isShaConflict(e) {
  return String(e && e.message ? e.message : e).indexOf('GitHub API 409') !== -1;
}

/**
 * Message de commit déterministe : deux exécutions du même article
 * produisent le même message (traçabilité sans créer de divergence).
 */
function publishCommitMessage(article) {
  return 'Publication : ' + String(article.SLUG || article.ID || 'article');
}

/* -------------------------------------------------------------------------- */
/* Transitions d'état                                                         */
/* -------------------------------------------------------------------------- */

/** READY/DRAFT → PUBLISHING. */
function markPublishing(id) {
  updateArticleFields(id, { STATUS: STATUS.PUBLISHING, ERROR: '' });
}

/** PUBLISHING → ERROR, avec le motif. */
function markError(id, message) {
  updateArticleFields(id, { STATUS: STATUS.ERROR, ERROR: message });
}

/**
 * PUBLISHING → statut d'origine.
 * Un mode test ou un verrou fermé n'est pas une erreur d'article : la ligne
 * doit rester publiable, donc restaurée et non marquée ERROR.
 */
function restoreStatus(id, status) {
  updateArticleFields(id, { STATUS: status, ERROR: '' });
}

/**
 * Réconciliation d'index en échec APRÈS une écriture aboutie.
 *
 * Renvoie le message à porter en colonne ERROR, ou '' si tout va bien. Le
 * journal est écrit ici, et nowhere else : un index en retard ne doit JAMAIS
 * être un simple `warning` noyé dans les DÉTAILS d'une ligne de succès.
 *
 * Le STATUT n'est volontairement pas touché. L'article est réellement publié :
 * le mettre en ERROR le ferait disparaître d'`articles.json` à la prochaine
 * réconciliation (`isPublishable()` ne retient que PUBLISHED), donc du blog
 * public, alors que son fichier est en ligne. Ce qui doit être visible, c'est
 * la colonne ERROR — c'est elle que l'opérateur voit dans la feuille.
 *
 * @param {'publié'|'supprimé'} kind
 * @param {number|string} id
 * @param {Object} article
 * @param {{ok:boolean, warnings:Array, writes:number}} indexes
 * @return {string} message écrit en colonne ERROR ('' si rien à signaler)
 */
function markIndexFailure(kind, id, article, indexes) {
  if (!indexes || indexes.ok !== false) return '';

var warnings = indexes.warnings || [];
  var codes = warnings.map(function (w) { return w.code; });
  // La CAUSE est recopiée dans la colonne ERROR : sans elle, l'opérateur ne peut
  // pas deviner quel index est en retard sans ouvrir le journal.
  var first = warnings.length ? String(warnings[0].message || '') : '';
  var message = 'Article ' + kind + ', index Blog NON réconcilié : ' +
    (first || 'cause inconnue') +
    '. Corrigez la cause puis remettez la ligne en READY pour réconcilier.' +
    (codes.length ? ' [' + codes.join(', ') + ']' : '');

  updateArticleFields(id, { ERROR: message });
  logError(kind === 'supprimé' ? 'delete' : 'publish', message, {
    articleId: id,
    slug: article && article.SLUG,
    status: article && article.STATUS,
    githubPath: article && article.GITHUB_PATH,
    details: {
      indexed: false,
      writes: typeof indexes.writes === 'number' ? indexes.writes : -1,
      warnings: warnings
    }
  });
  return message;
}

/**
 * Appel de réconciliation garanti sans exception.
 *
 * `updateIndexesForArticle()` et `removeIndexesForArticle()` promettent de ne
 * jamais lever, mais l'article est DÉJÀ écrit à cet instant : une exception
 * ici laisserait la ligne figée, ou pire, la ferait disparaître sans trace.
 * Le rapport est donc normalisé ici, une fois pour les deux flux.
 *
 * @param {Function} fn
 * @return {{ok:boolean, warnings:Array, writes:number, indexed:boolean}}
 */
function safeIndexReconcile(fn) {
  var report;
  try {
    report = fn();
  } catch (e) {
    var message = redact(String(e && e.message ? e.message : e));
    return {
      ok: false,
      indexed: false,
      writes: 0,
      warnings: [{ code: 'INDEX_THREW', message: message }]
    };
  }
  report.indexed = report.ok !== false;
  return report;
}

/* -------------------------------------------------------------------------- */
/* Résultat                                                                   */
/* -------------------------------------------------------------------------- */

function describeRenderErrors(errors) {
  if (!errors || !errors.length) return 'Erreur de rendu non détaillée.';
  return errors.map(function (e) {
    return (e.code ? e.code + ' ' : '') + e.message;
  }).join(' ; ');
}

/** Raccourci : échec contrôlé, ligne passée en ERROR. */
function failToError(id, article, code, message) {
  var safe = redact(String(message || ''));
  markError(id, safe);
  logError('publish', safe, {
    articleId: id,
    slug: article.SLUG,
    status: STATUS.ERROR,
    githubPath: article.GITHUB_PATH
  });
  var failed = failure(code, safe, article, { status: STATUS.ERROR });
  var fresh = findArticleById(id);
  if (fresh) failed.status = fresh.STATUS;
  return failed;
}

function publishResult(overrides) {
  var base = {
    ok: false,
    code: 'UNKNOWN',
    message: '',
    articleId: '',
    title: '',
    slug: '',
    status: '',
    statusBefore: '',
    githubPath: '',
    githubSha: '',
    githubCommit: '',
    publishedAt: '',
    sitePath: '',
    testMode: false,
    bytes: 0,
    retried: false,
    remaining: 0,
    // `null` = indexation non applicable (échec AVANT toute écriture : rien n'a
    // été publié, il n'y a donc rien à réconcilier). Seuls les chemins qui
    // publient réellement tranchent : `true` réconcilié, `false` en retard.
    indexed: null,
    indexWrites: 0,
    errors: [],
    warnings: [],
    validation: null
  };
  var out = Object.assign(base, overrides || {});
  if (out.article && typeof out.article === 'object') {
    if (!out.articleId) out.articleId = out.article.ID || '';
    if (!out.title) out.title = out.article.TITLE || '';
    if (!out.slug) out.slug = out.article.SLUG || '';
    if (!out.statusBefore) out.statusBefore = out.article.STATUS || '';
    if (!out.githubPath) out.githubPath = out.article.GITHUB_PATH || '';
    if (!out.githubSha) out.githubSha = out.article.GITHUB_SHA || '';
    if (!out.githubCommit) out.githubCommit = out.article.GITHUB_COMMIT || '';
    if (!out.publishedAt) out.publishedAt = out.article.PUBLISHED_AT || '';
  }
  return out;
}

function failure(code, message, article, overrides) {
  return publishResult(Object.assign({
    ok: false,
    code: code,
    message: message
  }, overrides || {}, { article: article || null }));
}

function success(article, overrides) {
  return publishResult(Object.assign({ ok: true }, overrides || {}, {
    article: article || null
  }));
}

/* -------------------------------------------------------------------------- */
/* Présentation                                                               */
/* -------------------------------------------------------------------------- */

/** Compte rendu lisible, sans jamais exposer de détail technique sensible. */
function formatPublishReport(result) {
  if (!result) return 'Publication : aucun résultat.';

  var lines = [];
  var label = result.ok
    ? (result.code === 'UNCHANGED' ? 'Publication : INCHANGÉE' : 'Publication : RÉUSSIE')
    : 'Publication : ÉCHEC';

  lines.push(label);
  lines.push('');
  if (result.title || result.slug) {
    lines.push('Article   : ' + (result.title || result.slug) +
      (result.slug ? ' (' + result.slug + ')' : ''));
  }
  if (result.statusBefore) lines.push('Statut    : ' + result.statusBefore + ' → ' + result.status);
  if (result.message) lines.push('Détail    : ' + result.message);

  if (result.ok) {
    if (result.sitePath) lines.push('URL       : ' + buildSiteUrl(result.sitePath));
    if (result.githubPath) lines.push('Fichier   : ' + result.githubPath);
    if (result.githubSha) lines.push('SHA       : ' + result.githubSha.slice(0, 12));
    if (result.githubCommit) lines.push('Commit    : ' + result.githubCommit.slice(0, 12));
    if (result.publishedAt) lines.push('Publié le : ' + frenchDate(result.publishedAt));
    lines.push('Octets    : ' + result.bytes);
    // L'indexation des pages statiques est un résultat À PART ENTIÈRE : un
    // article publié mais invisible dans le hub doit être visible comme tel.
    if (result.indexed === false) {
      lines.push('Index     : NON RÉCONCILIÉ (article publié, sommaire à reprendre)');
    } else if (result.indexWrites) {
      lines.push('Index     : ' + result.indexWrites + ' index mis à jour');
    }
  }

  if (result.testMode) {
    lines.push('', 'Mode test : rendu et validation exécutés, AUCUNE écriture GitHub.');
  }
  if (result.remaining > 0) {
    lines.push('', result.remaining + ' autre(s) article(s) READY non traité(s) ' +
      '(un article par exécution).');
  }
  if (result.warnings && result.warnings.length) {
    lines.push('', 'Avertissements :');
    result.warnings.slice(0, 5).forEach(function (w) {
      lines.push('- ' + ((w.code ? w.code + ' ' : '') + w.message));
    });
  }
  return lines.join('\n');
}
