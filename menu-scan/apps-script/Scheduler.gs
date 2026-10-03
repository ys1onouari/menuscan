/**
 * Menu Scan — Publication automatisée du Blog
 * Module : Scheduler.gs
 * ---------------------------------------------------------------------------
 * Deux responsabilités, strictement séparées :
 *   1. l'INTERFACE DE CONFIGURATION de la planification (dialogue D6-A) ;
 *   2. le MOTEUR D'EXÉCUTION du déclencheur (D6-B), SANS UI.
 *
 * SOURCE DE VÉRITÉ : la feuille `Config`, via les primitives existantes
 * `readConfigMap()` (lecture) et `setConfigValue()` (écriture). Aucun second
 * magasin de configuration, aucun Script Property pour la planification,
 * aucun planning codé en dur. Aucune clé de configuration nouvelle.
 *
 * RÈGLE DE RÉPARTITION : celle déjà appliquée par `validateConfig()`
 * (Validator.gs, contrôles C3 et C3b) — `ARTICLES_PER_WEEK` doit être un
 * multiple exact du nombre de jours sélectionnés. Ce module n'invente donc
 * AUCUN algorithme de planification : il applique la règle existante, l'affiche
 * et l'applique à l'exécution.
 *
 * ARCHITECTURE (D6-B) :
 *   `feuille Config` → UN SEUL déclencheur quotidien (`runScheduledPublication`)
 *   → scheduler (jour + quota + plafond) → `publishArticleById(id)` EXISTANT
 *   → GitHub → `Articles` + `Logs`.
 *
 *   Le scheduler ne duplique AUCUNE responsabilité du Publisher : verrou,
 *   transitions de statut, `publishGate()`, `TEST_MODE`, opérations GitHub et
 *   journalisation restent dans `Publisher.gs`. Le scheduler ne fait que
 *   décider QUAND, COMBIEN et SUR QUELS articles appeler ce point d'entrée.
 *
 *   UN SEUL déclencheur QUOTIDIEN, pas un par jour de `PUBLISH_DAYS` : le
 *   déclencheur sonne tous les jours, c'est le moteur qui teste le jour.
 *
 * ABSENCE D'UI (invariant D6-B) : ni `SpreadsheetApp.getUi()`, ni alerte, ni
 * dialogue, ni cellule ou plage active dans le chemin d'exécution du
 * déclencheur. Une exécution planifiée doit fonctionner sans personne devant
 * l'écran.
 */

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Modes réellement supportés. `WEEKLY` est le seul mode présent dans
 * `CONFIG_DEFAULTS` et le seul mode dont la règle de répartition existe.
 * Aucun mode n'est ajouté ici.
 */
var SCHEDULER_MODES = ['WEEKLY'];
var SCHEDULER_DEFAULT_MODE = 'WEEKLY';

/**
 * Bornes de saisie. Le moteur de publication traitant UN SEUL article par
 * invocation (Code.gs) et une répartition paire plafonnée à un article par
 * jour, ces bornes découlent de la règle existante — elles ne créent aucun
 * comportement nouveau.
 */
var SCHEDULER_MAX_ARTICLES_PER_WEEK = 7;
var SCHEDULER_MAX_ARTICLES_PER_RUN = 7;

/** Ordre canonique des jours : jamais l'ordre de saisie. */
var PUBLISH_DAY_ORDER = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY'
];

var PUBLISH_DAY_LABELS = {
  MONDAY: 'Lundi',
  TUESDAY: 'Mardi',
  WEDNESDAY: 'Mercredi',
  THURSDAY: 'Jeudi',
  FRIDAY: 'Vendredi',
  SATURDAY: 'Samedi',
  SUNDAY: 'Dimanche'
};

/** Clés que ce dialogue est autorisé à écrire. Rien d'autre n'est touché. */
var SCHEDULER_WRITABLE_KEYS = [
  'AUTO_PUBLISH',
  'SCHEDULE_MODE',
  'ARTICLES_PER_WEEK',
  'PUBLISH_DAYS',
  'MAX_ARTICLES_PER_RUN'
];

/* -------------------------------------------------------------------------- */
/* Constantes d'exécution (D6-B)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Nom EXACT de la fonction installée comme déclencheur.
 *
 * C'est aussi le FILTRE d'identification : l'installation comme le retrait ne
 * touchent qu'un déclencheur dont `getHandlerFunction()` rend cette valeur.
 * Tout autre déclencheur du projet reste intouché — un déclencheur tiers ne
 * peut être ni supprimé, ni « réconcilié », ni compté comme le nôtre.
 */
var SCHEDULER_TRIGGER_HANDLER = 'runScheduledPublication';

/**
 * Attente du verrou de DOCUMENT, en ms. Échec rapide assumé, comme
 * `PUBLISH_LOCK_MS` : si une exécution est déjà en cours, la suivante sort
 * immédiatement plutôt que d'empiler des travaux.
 */
var SCHEDULER_LOCK_MS = 1000;

/* -------------------------------------------------------------------------- */
/* Normalisation des jours                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalise une liste de jours : majuscules, valeurs inconnues ignorées,
 * doublons supprimés, ordre canonique guarantees.
 * @param {Array<string>|string} days
 * @return {Array<string>}
 */
function normalizePublishDays(days) {
  var list = Array.isArray(days) ? days : String(days || '').split(',');
  var seen = {};
  list.forEach(function (d) {
    var key = String(d === null || d === undefined ? '' : d).trim().toUpperCase();
    if (PUBLISH_DAY_ORDER.indexOf(key) !== -1) seen[key] = true;
  });
  return PUBLISH_DAY_ORDER.filter(function (d) { return seen[d] === true; });
}

/** Liste normalisée → chaîne stockée dans `PUBLISH_DAYS`. */
function serializePublishDays(days) {
  return normalizePublishDays(days).join(',');
}

/** Valeur Config brute → liste normalisée. */
function parsePublishDays(raw) {
  return normalizePublishDays(String(raw === null || raw === undefined ? '' : raw).split(','));
}

function isPublishDay(value) {
  return PUBLISH_DAY_ORDER.indexOf(String(value || '').trim().toUpperCase()) !== -1;
}

/* -------------------------------------------------------------------------- */
/* Résumé de répartition                                                      */
/* -------------------------------------------------------------------------- */

function isWholeNumber(value) {
  var n = Number(value);
  return String(value).trim() !== '' && isFinite(n) && Math.floor(n) === n;
}

/**
 * Applique la règle existante de répartition paire.
 * `even === false` signifie exactement ce que `validateConfig()` refuse
 * (C3b) : le total ne se divise pas sur le nombre de jours.
 * @return {{perWeek:number, days:Array<string>, perDay:number, even:boolean}}
 */
function computeScheduleSummary(perWeek, days) {
  var normalizedDays = normalizePublishDays(days);
  var total = Number(perWeek);
  var safeTotal = isFinite(total) ? total : 0;
  if (!normalizedDays.length || safeTotal <= 0) {
    return { perWeek: safeTotal, days: normalizedDays, perDay: 0, even: false };
  }
  var perDay = safeTotal / normalizedDays.length;
  return {
    perWeek: safeTotal,
    days: normalizedDays,
    perDay: perDay,
    even: Math.floor(perDay) === perDay
  };
}

/* -------------------------------------------------------------------------- */
/* Heure de publication (D6-B)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lit `PUBLISH_HOUR` / `PUBLISH_MINUTE` dans la configuration EXISTANTE.
 *
 * AUCUNE valeur par défaut n'est inventée : ces deux clés sont volontairement
 * vides dans `CONFIG_DEFAULTS` (Config.gs) et sont fixées par l'opérateur dans
 * la feuille `Config`. Une valeur absente ou illisible est un REFUS, jamais
 * « 8h » ou « 0h » par défaut — un déclencheur silencieux à une heure
 * inventée publierait sans que personne l'ait demandé.
 *
 * @param {Object=} map map Config déjà lue (évite une relecture de feuille)
 * @return {{ok:boolean, hour:number, minute:number, code:string, message:string}}
 */
function readPublishClock(map) {
  var config = map;
  if (!config) {
    try {
      config = readConfigMap();
    } catch (e) {
      return {
        ok: false, hour: null, minute: null, code: 'SCHED_CONFIG_UNREADABLE',
        message: 'Configuration illisible : ' +
          redact(String(e && e.message ? e.message : e))
      };
    }
  }

  var hourRaw = String(config.PUBLISH_HOUR === null || config.PUBLISH_HOUR === undefined
    ? '' : config.PUBLISH_HOUR).trim();
  var minuteRaw = String(config.PUBLISH_MINUTE === null || config.PUBLISH_MINUTE === undefined
    ? '' : config.PUBLISH_MINUTE).trim();

  if (hourRaw === '') {
    return {
      ok: false, hour: null, minute: null, code: 'SCHED_PUBLISH_HOUR',
      message: 'PUBLISH_HOUR est vide : configurez d\'abord l\'heure de publication ' +
        '(0-23) dans la feuille Config (clé PUBLISH_HOUR, colonne B), puis ' +
        'relancez « Installer / mettre à jour le déclencheur ». ' +
        'Aucune heure n\'est inventée : aucun déclencheur créé.'
    };
  }
  if (minuteRaw === '') {
    return {
      ok: false, hour: null, minute: null, code: 'SCHED_PUBLISH_MINUTE',
      message: 'PUBLISH_MINUTE est vide : configurez d\'abord la minute de publication ' +
        '(0-59) dans la feuille Config (clé PUBLISH_MINUTE, colonne B), puis ' +
        'relancez « Installer / mettre à jour le déclencheur ». ' +
        'Aucune minute n\'est inventée : aucun déclencheur créé.'
    };
  }
  if (!isWholeNumber(hourRaw) || Number(hourRaw) < 0 || Number(hourRaw) > 23) {
    return {
      ok: false, hour: null, minute: null, code: 'SCHED_PUBLISH_TIME_INVALID',
      message: 'PUBLISH_HOUR illisible : « ' + redact(hourRaw) + ' » ' +
        '(entier 0-23 attendu). Aucun déclencheur créé.'
    };
  }
  if (!isWholeNumber(minuteRaw) || Number(minuteRaw) < 0 || Number(minuteRaw) > 59) {
    return {
      ok: false, hour: null, minute: null, code: 'SCHED_PUBLISH_TIME_INVALID',
      message: 'PUBLISH_MINUTE illisible : « ' + redact(minuteRaw) + ' » ' +
        '(entier 0-59 attendu). Aucun déclencheur créé.'
    };
  }

  return { ok: true, hour: Number(hourRaw), minute: Number(minuteRaw), code: 'OK', message: '' };
}

/* -------------------------------------------------------------------------- */
/* Déclencheur (D6-B)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `true` si ce déclencheur est celui du scheduler. Filtre STRICT : le handler
 * doit être exactement `SCHEDULER_TRIGGER_HANDLER`. Un objet sans
 * `getHandlerFunction()` n'est jamais considéré comme le nôtre (on ne supprime
 * jamais un déclencheur qu'on ne sait pas lire).
 */
function isSchedulerTrigger(trigger) {
  try {
    if (!trigger || typeof trigger.getHandlerFunction !== 'function') return false;
    return trigger.getHandlerFunction() === SCHEDULER_TRIGGER_HANDLER;
  } catch (e) {
    return false;
  }
}

/**
 * Heure d'un déclencheur installed, ou `null` si elle est illisible.
 * Un déclencheur dont on ne sait pas lire l'heure est traité comme
 * « correspondant » (cf. `triggerClockMatches`) : on ne supprime JAMAIS à
 * l'aveugle un déclencheur qu'on ne peut pas inspecter.
 */
function triggerHour(trigger) {
  try {
    if (!trigger || typeof trigger.getHour !== 'function') return null;
    var h = trigger.getHour();
    return isWholeNumber(h) ? Number(h) : null;
  } catch (e) {
    return null;
  }
}

function triggerMinute(trigger) {
  try {
    if (!trigger || typeof trigger.getMinute !== 'function') return null;
    var m = trigger.getMinute();
    return isWholeNumber(m) ? Number(m) : null;
  } catch (e) {
    return null;
  }
}

/** `true` si le déclencheur correspond à l'heure configurée (ou reste opaque). */
function triggerClockMatches(trigger, clock) {
  var h = triggerHour(trigger);
  var m = triggerMinute(trigger);
  if (h === null || m === null) return true;
  return h === clock.hour && m === clock.minute;
}

/**
 * Déclencheurs du scheduler présents dans le projet. LECTURE SEULE.
 * @return {{ok:boolean, triggers:Array, code:string, message:string}}
 */
function listSchedulerTriggers() {
  var all;
  try {
    all = ScriptApp.getProjectTriggers() || [];
  } catch (e) {
    return {
      ok: false, triggers: [], code: 'SCHED_TRIGGERS_UNREADABLE',
      message: 'Déclencheurs illisibles : ' +
        redact(String(e && e.message ? e.message : e))
    };
  }
  return { ok: true, triggers: all.filter(isSchedulerTrigger), code: 'OK', message: '' };
}

/**
 * État réel de l'automatisation. LECTURE SEULE : rien n'est créé ni supprimé.
 *
 * `count` = TOUS les déclencheurs du projet (clé historique D6-A),
 * `schedulerCount` = ceux qui sont les nôtres. `installed` est vrai pour
 * exactement UN déclencheur du scheduler ; au-delà, l'état est un DOUBLON à
 * signaler, jamais une automatisation « qui fonctionne ».
 */
function describeSchedulerTriggers() {
  var listing = listSchedulerTriggers();
  var clock = readPublishClock();

  if (!listing.ok) {
    return {
      readable: false,
      count: -1,
      schedulerCount: -1,
      otherCount: -1,
      installed: false,
      duplicates: false,
      automationRunning: false,
      handler: SCHEDULER_TRIGGER_HANDLER,
      hour: null,
      minute: null,
      clockOk: clock.ok,
      clockCode: clock.ok ? '' : clock.code,
      clockMessage: clock.ok ? '' : clock.message,
      timeZone: safeConfiguredTimeZone()
    };
  }

  var all = 0;
  try {
    all = (ScriptApp.getProjectTriggers() || []).length;
  } catch (e) {
    all = listing.triggers.length;
  }

  var first = listing.triggers.length ? listing.triggers[0] : null;
  var duplicate = listing.triggers.length > 1;

  return {
    readable: true,
    count: all,
    schedulerCount: listing.triggers.length,
    otherCount: Math.max(all - listing.triggers.length, 0),
    installed: listing.triggers.length === 1,
    duplicates: duplicate,
    // « En exécution » signifie « une automatisation est Armée », pas « un
    // script tourne en ce moment » : un déclencheur n'est pas une exécution.
    automationRunning: listing.triggers.length === 1,
    handler: SCHEDULER_TRIGGER_HANDLER,
    hour: first ? triggerHour(first) : null,
    minute: first ? triggerMinute(first) : null,
    clockOk: clock.ok,
    clockCode: clock.ok ? '' : clock.code,
    clockMessage: clock.ok ? '' : clock.message,
    timeZone: safeConfiguredTimeZone()
  };
}

/**
 * Installe le déclencheur QUOTIDIEN unique du scheduler.
 *
 * IDEMPOTENCE (invariant) : jamais deux déclencheurs du scheduler.
 *   1. heure invalide/absente          → refus, AUCUN déclencheur créé ;
 *   2. déclencheur(s) déjà présents :
 *        - heure conforme  → les doublons excédentaires sont retirés, celui qui
 *          reste est conservé → `ALREADY_INSTALLED`, **0 création** ;
 *        - heure différente → le(s) déclencheur(s) du scheduler sont retirés
 *          AVANT la création du nouveau : il n'y a jamais deux déclencheurs en
 *          même temps, seulement zéro puis un ;
 *   3. aucun déclencheur → création d'UN déclencheur `timeBased()` quotidien.
 *
 * Les déclencheurs qui ne sont pas les nôtres ne sont JAMAIS supprimés, et la
 * suppression précède toujours la création (l'inverse laisserait un doublon).
 *
 * API utilized — `ClockTriggerBuilder` (cf. référence Apps Script) :
 * `timeBased().atHour(h).nearMinute(m).everyDays(1).create()`.
 * `nearMinute()` remplace `atMinute()`, qui N'EXISTE PAS sur ce builder
 * (cause racine du correctif D6-B : « atMinute is not a function » en
 * production). `everyDays(1)` est obligatoire avec `atHour`/`nearMinute`.
 * La plateforme n'offre pas de minute exacte : la minute configurée est une
 * minute VISÉE, ±15 min.
 */
function installSchedulerTrigger() {
  var map;
  try {
    map = readConfigMap();
  } catch (e) {
    var configError = redact(String(e && e.message ? e.message : e));
    logError('scheduler', 'Installation impossible : configuration illisible', {});
    return {
      ok: false,
      code: 'SCHED_CONFIG_UNREADABLE',
      message: 'Configuration illisible : ' + configError + '. Aucun déclencheur créé.',
      created: false,
      removed: 0,
      state: null
    };
  }

  var clock = readPublishClock(map);
  if (!clock.ok) {
    logScheduler('Installation du déclencheur refusée : heure de publication invalide', {
      code: clock.code
    });
    return {
      ok: false,
      code: clock.code,
      message: clock.message,
      created: false,
      removed: 0,
      state: getSchedulerConfigState()
    };
  }

  var listing = listSchedulerTriggers();
  if (!listing.ok) {
    logScheduler('Installation impossible : déclencheurs illisibles', { code: listing.code });
    return {
      ok: false,
      code: listing.code,
      message: listing.message,
      created: false,
      removed: 0,
      state: getSchedulerConfigState()
    };
  }

  var removed = 0;
  var kept = [];
  listing.triggers.forEach(function (trigger) {
    if (triggerClockMatches(trigger, clock) && kept.length === 0) {
      kept.push(trigger);
      return;
    }
    // Doublon excédentaire, ou déclencheur à l'ancienne heure : retrait ciblé.
    removeSchedulerTriggerOne(trigger);
    removed += 1;
  });

  if (kept.length) {
    logScheduler('Déclencheur du scheduler déjà installé : aucun second déclencheur créé', {
      hour: clock.hour,
      minute: clock.minute,
      removed: removed
    });
    return {
      ok: true,
      code: 'ALREADY_INSTALLED',
      message: 'Un déclencheur quotidien du scheduler est déjà installé (' +
        pad2(clock.hour) + 'h' + pad2(clock.minute) + '). Aucun second déclencheur créé.' +
        (removed ? ' ' + removed + ' doublon(s) retiré(s).' : ''),
      created: false,
      removed: removed,
      state: getSchedulerConfigState()
    };
  }

  var created = null;
  try {
    // API Apps Script COMPLÈTE : `TriggerBuilder.timeBased()` renvoie un
    // `ClockTriggerBuilder`, qui n'expose NI `atMinute()` NI un minute exact.
    //   - `atHour(h)`      → fenêtre de l'heure h ;
    //   - `nearMinute(m)`  → minute VISÉE (±15 min, limite de la plateforme) ;
    //   - `everyDays(1)`   → OBLIGATOIRE dès lors qu'on utilise atHour/nearMinute
    //                        (« Frequency is required if you are using atHour()
    //                        or nearMinute() », référence officielle).
    // Un seul déclencheur quotidien, comme avant : rien d'autre n'est créé.
    created = ScriptApp
      .newTrigger(SCHEDULER_TRIGGER_HANDLER)
      .timeBased()
      .atHour(clock.hour)
      .nearMinute(clock.minute)
      .everyDays(1)
      .create();
  } catch (e) {
    var message = redact(String(e && e.message ? e.message : e));
    logError('scheduler', 'Création du déclencheur impossible : ' + message, {
      details: { hour: clock.hour, minute: clock.minute }
    });
    return {
      ok: false,
      code: 'SCHED_TRIGGER_CREATE_FAILED',
      message: 'Création du déclencheur impossible : ' + message +
        (removed ? ' ' + removed + ' ancien(s) déclencheur(s) retiré(s) : réinstallez.' : ''),
      created: false,
      removed: removed,
      state: getSchedulerConfigState()
    };
  }

  logScheduler('Déclencheur quotidien du scheduler installé', {
    hour: clock.hour,
    minute: clock.minute,
    removed: removed,
    trigger_id: created && typeof created.getUniqueId === 'function' ? created.getUniqueId() : '(inconnu)'
  });

  var publishDays = parsePublishDays(map.PUBLISH_DAYS);
  var dayLabels = publishDays.map(function (d) { return PUBLISH_DAY_LABELS[d]; });

  return {
    ok: true,
    code: 'INSTALLED',
    message: 'Déclencheur quotidien installé (' + pad2(clock.hour) + 'h' + pad2(clock.minute) +
      ', ' + safeConfiguredTimeZone() + ') : l\'exécution ne publiera que ' +
      (dayLabels.length ? dayLabels.join(', ') : 'les jours de PUBLISH_DAYS') +
      ' et seulement si AUTO_PUBLISH=TRUE.' +
      (removed ? ' ' + removed + ' ancien(s) déclencheur(s) retiré(s).' : ''),
    created: true,
    removed: removed,
    state: getSchedulerConfigState()
  };
}

/**
 * Retire le déclencheur du scheduler.
 *
 * SÛRETÉ : `ScriptApp.deleteTrigger()` n'est appelé que sur un déclencheur dont
 * `getHandlerFunction()` vaut `SCHEDULER_TRIGGER_HANDLER`. Les autres
 * déclencheurs du projet sont laissés intacts, et un retrait déjà effectué ne
 * échoue pas (`NOT_INSTALLED`).
 */
function removeSchedulerTrigger() {
  var listing = listSchedulerTriggers();
  if (!listing.ok) {
    logScheduler('Retrait impossible : déclencheurs illisibles', { code: listing.code });
    return {
      ok: false,
      code: listing.code,
      message: listing.message,
      removed: 0,
      state: getSchedulerConfigState()
    };
  }

  var removed = 0;
  var errors = [];
  listing.triggers.forEach(function (trigger) {
    if (removeSchedulerTriggerOne(trigger)) removed += 1;
    else errors.push(String(redact('retrait refusé pour un déclencheur du scheduler')));
  });

  logScheduler(removed ? 'Déclencheur du scheduler retiré' : 'Aucun déclencheur du scheduler à retirer', {
    removed: removed
  });

  return {
    ok: errors.length === 0,
    code: errors.length ? 'SCHED_TRIGGER_REMOVE_FAILED' : (removed ? 'REMOVED' : 'NOT_INSTALLED'),
    message: errors.length
      ? 'Retrait partiel : ' + errors.join(', ') + '.'
      : (removed
        ? removed + ' déclencheur(s) du scheduler retiré(s). Aucun autre déclencheur touché.'
        : 'Aucun déclencheur du scheduler installé : rien à retirer.'),
    removed: removed,
    state: getSchedulerConfigState()
  };
}

/**
 * Retire UN déclencheur, et lui seul. `false` si l'API refuse : l'appelant
 * décide alors s'il doit poursuivre ou s'arrêter (aucune exception avalée).
 */
function removeSchedulerTriggerOne(trigger) {
  if (!isSchedulerTrigger(trigger)) return false;
  try {
    ScriptApp.deleteTrigger(trigger);
    return true;
  } catch (e) {
    console.error('Retrait du déclencheur refusé : ' +
      redact(String(e && e.message ? e.message : e)));
    return false;
  }
}

/**
 * État du déclencheur, tel qu'affiché par le bouton « État du déclencheur ».
 *
 * Enveloppe commune aux 3 actions du dialogue : `{ok, code, message, triggers}`
 * — `message` est déjà la phrase d'état affichable, `triggers` permet de
 * rafraîchir le bandeau sans relire la feuille `Config`.
 */
function getSchedulerTriggerStatus() {
  var triggers = describeSchedulerTriggers();
  return {
    ok: triggers.readable === true,
    code: triggers.readable !== true
      ? 'SCHED_TRIGGERS_UNREADABLE'
      : (triggers.schedulerCount === 0
        ? 'NOT_INSTALLED'
        : (triggers.schedulerCount > 1 ? 'DUPLICATE' : 'INSTALLED')),
    message: triggerStatusText(triggers),
    triggers: triggers,
    readable: triggers.readable,
    installed: triggers.installed,
    schedulerCount: triggers.schedulerCount,
    duplicates: triggers.duplicates,
    handler: triggers.handler,
    hour: triggers.hour,
    minute: triggers.minute,
    clockOk: triggers.clockOk,
    clockCode: triggers.clockCode,
    clockMessage: triggers.clockMessage,
    timeZone: triggers.timeZone,
    text: triggerStatusText(triggers)
  };
}

/* -------------------------------------------------------------------------- */
/* Quota d'exécution (D6-B)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Plafond réel d'une exécution planifiée.
 *
 *   dailyQuota     = ARTICLES_PER_WEEK / nombre de jours sélectionnés
 *                    (règle DÉJÀ appliquée par `validateConfig()`, C3/C3b)
 *   effectiveLimit = Math.min(dailyQuota, MAX_ARTICLES_PER_RUN)
 *
 * `computeScheduleSummary()` est RÉUTILISÉ tel quel : aucune seconde règle de
 * répartition n'est introduite. Si le total ne se divise pas exactement, on
 * REFUSE (0 publication) au lieu d'arrondir — un arrondi violerait silencieusement
 * la règle de répartition que l'opérateur a choisie.
 *
 * @param {Object} map map Config
 * @return {{ok:boolean, code:string, message:string, dailyQuota:number,
 *           effectiveLimit:number, maxPerRun:number, days:Array<string>}}
 */
function computeEffectiveLimit(map) {
  var config = map || {};
  var quota = computeScheduleSummary(config.ARTICLES_PER_WEEK, parsePublishDays(config.PUBLISH_DAYS));

  if (!quota.days.length) {
    return {
      ok: false, code: 'PUBLISH_DAYS_EMPTY',
      message: 'PUBLISH_DAYS vide : aucun jour de publication sélectionné. Aucun article publié.',
      dailyQuota: 0, effectiveLimit: 0, maxPerRun: 0, days: quota.days
    };
  }

  if (!isWholeNumber(config.ARTICLES_PER_WEEK) || Number(config.ARTICLES_PER_WEEK) <= 0) {
    return {
      ok: false, code: 'SCHED_PER_WEEK',
      message: 'ARTICLES_PER_WEEK illisible : « ' + redact(String(config.ARTICLES_PER_WEEK)) +
        ' » (entier 1-' + SCHEDULER_MAX_ARTICLES_PER_WEEK + ' attendu). Aucun article publié.',
      dailyQuota: 0, effectiveLimit: 0, maxPerRun: 0, days: quota.days
    };
  }

  if (!quota.even) {
    return {
      ok: false, code: 'SCHED_DISTRIBUTION',
      message: 'ARTICLES_PER_WEEK (' + quota.perWeek + ') ne se répartit pas également sur ' +
        quota.days.length + ' jour(s) : aucun article publié.',
      dailyQuota: quota.perDay, effectiveLimit: 0, maxPerRun: 0, days: quota.days
    };
  }

  if (!isWholeNumber(config.MAX_ARTICLES_PER_RUN) || Number(config.MAX_ARTICLES_PER_RUN) < 1) {
    return {
      ok: false, code: 'SCHED_MAX_PER_RUN',
      message: 'MAX_ARTICLES_PER_RUN illisible : « ' + redact(String(config.MAX_ARTICLES_PER_RUN)) +
        ' » (entier 1-' + SCHEDULER_MAX_ARTICLES_PER_RUN + ' attendu). Aucun article publié.',
      dailyQuota: quota.perDay, effectiveLimit: 0, maxPerRun: 0, days: quota.days
    };
  }

  var maxPerRun = Number(config.MAX_ARTICLES_PER_RUN);
  var effectiveLimit = Math.min(quota.perDay, maxPerRun);
  if (!isFinite(effectiveLimit) || effectiveLimit < 1) {
    return {
      ok: false, code: 'SCHED_LIMIT_INVALID',
      message: 'Plafond d\'execution calculé nul ou invalide : aucun article publié.',
      dailyQuota: quota.perDay, effectiveLimit: 0, maxPerRun: maxPerRun, days: quota.days
    };
  }

  return {
    ok: true, code: 'OK', message: '',
    dailyQuota: quota.perDay, effectiveLimit: effectiveLimit,
    maxPerRun: maxPerRun, days: quota.days
  };
}

/**
 * Jour de la semaine LOCAL, dans le fuseau configuré (`TIMEZONE`).
 *
 * Réutilise `zoneOffsetMinutes()` (Utils.gs) : aucun décalage n'est codé en dur,
 * donc aucun écart possible avec `PUBLISHED_AT`. `PUBLISH_DAY_ORDER` est
 * déjà indexé lundi = 0 … dimanche = 6, d'où `(getUTCDay() + 6) % 7`.
 *
 * @param {Date=} date instant de référence (injectable pour les tests)
 * @return {string} 'MONDAY' … 'SUNDAY'
 */
function currentPublishDay(date) {
  var instant = date || new Date();
  var local = new Date(instant.getTime() + zoneOffsetMinutes(instant) * 60000);
  return PUBLISH_DAY_ORDER[(local.getUTCDay() + 6) % 7];
}

/* -------------------------------------------------------------------------- */
/* Exécution planifiée (D6-B) — SANS UI                                        */
/* -------------------------------------------------------------------------- */

/**
 * POINT D'ENTRÉE DU DÉCLENCHEUR. Fonctionpoint de Python.
 *
 * Zéro dépendance UI : ni `SpreadsheetApp.getUi()`, ni alerte, ni dialogue, ni
 * cellule ou plage active. Elle doit fonctionner sans personne devant l'écran.
 *
 * Elle ne publie jamais elle-même : elle appelle `publishArticleById()`, qui
 * porte TOUT le pipeline existant (verrou, transitions, `publishGate()`,
 * `TEST_MODE`, GitHub, journal). Le scheduler ne fait que choisir les articles
 * et compter.
 *
 * CHEVAUCHEMENT : un verrou de DOCUMENT (`tryLock`, échec rapide) interdit à
 * deux exécutions de se superposer. Volontairement DIFFÉRENT du verrou de
 * script du Publisher : un verrou n'est pas réentrant, le détenir ici ferait
 * échouer toutes les publications (`LOCKED`). Les deux mécanismes restent
 * compatibles — le Publisher ignore toujours une publication concurrente, le
 * scheduler ignore toujours une exécution concurrente.
 *
 * @return {Object} rapport structuré, jamais d'exception
 */
function runScheduledPublication() {
  var lock = null;
  try {
    lock = typeof LockService.getDocumentLock === 'function'
      ? LockService.getDocumentLock()
      : null;
  } catch (e) {
    lock = null;
  }

  if (!lock) {
    // Le script doit être lié à un tableur pour disposer d'un verrou de
    // document. On REFUSE plutôt que de publier sans protection contre le
    // chevauchement : l'échec est journalisé et explicite, donc diagnosticable.
    logError('scheduler', 'Exécution planifiée refusée : verrou de document indisponible', {});
    return schedulerRunResult({
      ok: false,
      code: 'SCHED_LOCK_UNAVAILABLE',
      message: 'Verrou de document indisponible (script non lié à un tableur) : ' +
        'exécution refusée pour rester sans chevauchement. Aucun article publié.'
    });
  }

  if (!lock.tryLock(SCHEDULER_LOCK_MS)) {
    logInfo('scheduler', 'Exécution planifiée ignorée : une exécution est déjà en cours', {});
    return schedulerRunResult({
      ok: true,
      code: 'SCHED_ALREADY_RUNNING',
      message: 'Une exécution planifiée est déjà en cours : celle-ci sort, aucun doublon.'
    });
  }

  try {
    return runScheduledPublicationLocked();
  } catch (e) {
    var message = redact(String(e && e.message ? e.message : e));
    logError('scheduler', 'Exécution planifiée interrompue : ' + message, {});
    return schedulerRunResult({
      ok: false,
      code: 'SCHED_UNEXPECTED',
      message: 'Exécution interrompue : ' + message
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Corps de l'exécution, sous verrou. Cette fonction ne contient AUCUNE
 * acquisition de verrou : elle est appellée par `runScheduledPublication()`.
 */
function runScheduledPublicationLocked() {
  var map;
  try {
    map = readConfigMap();
  } catch (e) {
    var configMessage = redact(String(e && e.message ? e.message : e));
    logError('scheduler', 'Exécution planifiée : configuration illisible : ' + configMessage, {});
    return schedulerRunResult({
      ok: false, code: 'SCHED_CONFIG_UNREADABLE',
      message: 'Configuration illisible : ' + configMessage
    });
  }

  var autoPublish = normalizeBooleanInput(map.AUTO_PUBLISH) === 'TRUE';
  var testMode = normalizeBooleanInput(map.TEST_MODE) === 'TRUE';
  var day = currentPublishDay();

  /* --- 1. AUTO_PUBLISH : sortie propre, AUCUNE publication ---------------- */
  if (!autoPublish) {
    logScheduler('Exécution planifiée : AUTO_PUBLISH=FALSE, aucun article publié', { day: day });
    return schedulerRunResult({
      ok: true,
      code: 'AUTO_PUBLISH_OFF',
      message: 'AUTO_PUBLISH=FALSE : aucun article publié.',
      day: day, autoPublish: false, testMode: testMode
    });
  }

  /* --- 2. Jour sélectionné ----------------------------------------------- */
  var days = parsePublishDays(map.PUBLISH_DAYS);
  if (!days.length) {
    logScheduler('Exécution planifiée : PUBLISH_DAYS vide', { day: day });
    return schedulerRunResult({
      ok: true, code: 'PUBLISH_DAYS_EMPTY',
      message: 'PUBLISH_DAYS vide : aucun jour de publication.',
      day: day, autoPublish: true, testMode: testMode
    });
  }
  if (days.indexOf(day) === -1) {
    logScheduler('Exécution planifiée : jour non sélectionné', {
      day: day,
      publish_days: days.join(',')
    });
    return schedulerRunResult({
      ok: true, code: 'NOT_PUBLISH_DAY',
      message: 'Jour non sélectionné (' + day + ') : aucun article publié.',
      day: day, publishDay: false, autoPublish: true, testMode: testMode
    });
  }

  /* --- 3. Quota quotidien + plafond MAX_ARTICLES_PER_RUN ------------------ */
  var limit = computeEffectiveLimit(map);
  if (!limit.ok) {
    logScheduler('Exécution planifiée refusée : ' + limit.code, {
      code: limit.code,
      day: day,
      publish_days: days.join(',')
    });
    return schedulerRunResult({
      ok: false, code: limit.code, message: limit.message,
      day: day, publishDay: true, autoPublish: true, testMode: testMode,
      dailyQuota: limit.dailyQuota, effectiveLimit: 0
    });
  }

  /* --- 4. Articles READY -------------------------------------------------- */
  var ready = findArticlesByStatus(STATUS.READY);
  var selected = ready.slice(0, limit.effectiveLimit);
  var remaining = Math.max(ready.length - selected.length, 0);

  if (!selected.length) {
    logScheduler('Exécution planifiée : aucun article READY', {
      day: day,
      effective_limit: limit.effectiveLimit
    });
    return schedulerRunResult({
      ok: true, code: 'NO_READY',
      message: 'Aucun article READY à publier.',
      day: day, publishDay: true, autoPublish: true, testMode: testMode,
      dailyQuota: limit.dailyQuota, effectiveLimit: limit.effectiveLimit,
      remaining: ready.length
    });
  }

  /* --- 5. Publication SÉQUENTIELLE, bornée par effectiveLimit ------------- */
  var articles = [];
  var published = 0;
  var failed = 0;

  for (var i = 0; i < selected.length; i++) {
    var article = selected[i];
    var result = null;
    try {
      result = publishArticleById(article.ID);
    } catch (e) {
      // Filet de sécurité pour une exécution non surveillée : une exception
      // inattendue ne doit jamais interrompre le lot ni être rapportée comme
      // une réussite. AUCUNE reprise n'est inventée ici.
      result = {
        ok: false,
        code: 'UNEXPECTED',
        message: redact(String(e && e.message ? e.message : e)),
        testMode: false
      };
    }

    var succeeded = !!(result && result.ok === true);
    if (succeeded) published += 1;
    else failed += 1;

    articles.push({
      id: article.ID,
      slug: article.SLUG,
      ok: succeeded,
      code: result && result.code ? result.code : 'UNKNOWN',
      message: redact(String(result && result.message ? result.message : '')),
      testMode: !!(result && result.testMode === true)
    });
  }

  var code = failed === 0 ? 'PUBLISHED' : (published > 0 ? 'PARTIAL' : 'FAILED');
  var message = failed === 0
    ? published + ' article(s) publié(s).'
    : published + ' publication(s) réussie(s), ' + failed + ' en échec — voir la feuille Logs.';

  logScheduler('Exécution planifiée terminée : ' + code, {
    code: code,
    day: day,
    daily_quota: limit.dailyQuota,
    effective_limit: limit.effectiveLimit,
    max_per_run: limit.maxPerRun,
    published: published,
    failed: failed,
    remaining: remaining,
    test_mode: testMode,
    articles: articles.map(function (a) { return a.id + ':' + a.code; }).join(',')
  });

  return schedulerRunResult({
    // Un échec partiel ou total est un ÉCHEC de l'exécution : il ne doit jamais
    // pouvoir être lu comme « tout s'est bien passé ».
    ok: failed === 0,
    code: code,
    message: message,
    published: published,
    failed: failed,
    selected: selected.length,
    remaining: remaining,
    day: day,
    publishDay: true,
    autoPublish: true,
    testMode: testMode,
    dailyQuota: limit.dailyQuota,
    effectiveLimit: limit.effectiveLimit,
    maxPerRun: limit.maxPerRun,
    articles: articles
  });
}

/** Rapport structuré de l'exécution planifiée. Jamais d'exception. */
function schedulerRunResult(overrides) {
  var base = {
    ok: true,
    code: 'SCHEDULED',
    message: '',
    published: 0,
    failed: 0,
    selected: 0,
    remaining: 0,
    day: '',
    publishDay: false,
    autoPublish: false,
    testMode: false,
    dailyQuota: 0,
    effectiveLimit: 0,
    maxPerRun: 0,
    articles: []
  };
  return Object.assign(base, overrides || {});
}

/**
 * Journalisation du scheduler. Un échec d'écriture ne doit JAMAIS faire échouer
 * une exécution : il est seulement signalé sur la console d'exécution.
 */
function logScheduler(message, details) {
  try {
    logInfo('scheduler', message, details || {});
  } catch (e) {
    console.error('Journalisation du scheduler impossible : ' +
      redact(String(e && e.message ? e.message : e)));
  }
}

/** `TIMEZONE` sans jamais faire échouer une lecture d'état. */
function safeConfiguredTimeZone() {
  try {
    return getConfiguredTimeZone();
  } catch (e) {
    return '(illisible)';
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                     */
/* -------------------------------------------------------------------------- */

/** État complet du dialogue, lu depuis la feuille `Config`. */
function getSchedulerConfigState() {
  var map = readConfigMap();
  var days = parsePublishDays(map.PUBLISH_DAYS);
  var clock = readPublishClock(map);
  return {
    autoPublish: normalizeBooleanInput(map.AUTO_PUBLISH) === 'TRUE',
    mode: String(map.SCHEDULE_MODE || SCHEDULER_DEFAULT_MODE).trim().toUpperCase(),
    modes: SCHEDULER_MODES.slice(),
    perWeekRaw: String(map.ARTICLES_PER_WEEK),
    maxPerRunRaw: String(map.MAX_ARTICLES_PER_RUN),
    days: days,
    timeZone: getConfiguredTimeZone(),
    summary: computeScheduleSummary(map.ARTICLES_PER_WEEK, days),
    clock: clock,
    clockOk: clock.ok,
    clockMessage: clock.message,
    triggers: describeSchedulerTriggers(),
    schedulerImplemented: true
  };
}

/* -------------------------------------------------------------------------- */
/* Validation — miroir de validateConfig() (C3 / C3b)                         */
/* -------------------------------------------------------------------------- */

/**
 * Valide côté SERVEUR. Le client n'est jamais cru : rien n'est écrit tant que
 * cette fonction n'a pas renvoyé ok.
 * @param {{autoPublish:*, mode:*, perWeek:*, days:*, maxPerRun:*}} input
 * @return {{ok:boolean, errors:Array<{code:string,message:string}>, normalized:Object}}
 */
function validateSchedulerConfig(input) {
  var src = input && typeof input === 'object' ? input : {};
  var errors = [];

  var autoPublish = normalizeBooleanInput(src.autoPublish);
  if (autoPublish !== 'TRUE' && autoPublish !== 'FALSE') {
    errors.push({
      code: 'SCHED_AUTO_PUBLISH',
      message: 'Publication automatique : valeur TRUE ou FALSE attendue.'
    });
  }

  var mode = String(src.mode === null || src.mode === undefined ? '' : src.mode).trim().toUpperCase();
  if (SCHEDULER_MODES.indexOf(mode) === -1) {
    errors.push({
      code: 'SCHED_MODE',
      message: 'Mode non pris en charge (' + mode + '). Modes disponibles : ' +
        SCHEDULER_MODES.join(', ') + '.'
    });
  }

  var perWeek = Number(String(src.perWeek === null || src.perWeek === undefined ? '' : src.perWeek).trim());
  var perWeekOk = isWholeNumber(src.perWeek) && isFinite(perWeek) &&
    perWeek >= 1 && perWeek <= SCHEDULER_MAX_ARTICLES_PER_WEEK;
  if (!perWeekOk) {
    errors.push({
      code: 'SCHED_PER_WEEK',
      message: 'Articles par semaine : entier entre 1 et ' +
        SCHEDULER_MAX_ARTICLES_PER_WEEK + ' attendu.'
    });
  }

  var days = normalizePublishDays(src.days);
  // Miroir EXACT de C3 : la règle s'applique dès que ARTICLES_PER_WEEK > 0,
  // sans condition sur AUTO_PUBLISH ni sur SCHEDULE_MODE — comme dans
  // validateConfig(). Aucune règle supplémentaire n'est inventée ici.
  if (perWeekOk && perWeek > 0 && !days.length) {
    errors.push({
      code: 'SCHED_DAYS_EMPTY',
      message: 'Sélectionnez au moins un jour de publication.'
    });
  }
  // Règle existante C3b : la répartition doit être exacte.
  if (days.length && isWholeNumber(src.perWeek) && isFinite(perWeek) && perWeek > 0 &&
    perWeek % days.length !== 0) {
    errors.push({
      code: 'SCHED_DISTRIBUTION',
      message: 'Articles par semaine (' + perWeek + ') ne se répartit pas également sur ' +
        days.length + ' jour(s) : un multiple de ' + days.length + ' est requis.'
    });
  }

  var maxPerRun = Number(String(src.maxPerRun === null || src.maxPerRun === undefined ? '' : src.maxPerRun).trim());
  var maxOk = isWholeNumber(src.maxPerRun) && isFinite(maxPerRun) &&
    maxPerRun >= 1 && maxPerRun <= SCHEDULER_MAX_ARTICLES_PER_RUN;
  if (!maxOk) {
    errors.push({
      code: 'SCHED_MAX_PER_RUN',
      message: 'Articles maximum par exécution : entier entre 1 et ' +
        SCHEDULER_MAX_ARTICLES_PER_RUN + ' attendu.'
    });
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    normalized: {
      AUTO_PUBLISH: autoPublish,
      SCHEDULE_MODE: mode,
      ARTICLES_PER_WEEK: isFinite(perWeek) ? String(Math.floor(perWeek)) : '',
      PUBLISH_DAYS: serializePublishDays(days),
      MAX_ARTICLES_PER_RUN: isFinite(maxPerRun) ? String(Math.floor(maxPerRun)) : ''
    }
  };
}

function normalizeBooleanInput(value) {
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  var raw = String(value === null || value === undefined ? '' : value).trim().toUpperCase();
  if (raw === 'TRUE' || raw === 'FALSE') return raw;
  return '';
}

/* -------------------------------------------------------------------------- */
/* Écriture                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Valide puis écrit. N'écrit QUE les 5 clés de `SCHEDULER_WRITABLE_KEYS`,
 * via `setConfigValue()` (colonne B de la ligne visée, aucun réordonnancement).
 * Ne crée aucun déclencheur et ne modifie aucun autre réglage.
 */
function saveSchedulerConfig(input) {
  try {
    var check = validateSchedulerConfig(input);
    if (!check.ok) {
      return {
        ok: false,
        code: 'SCHED_INVALID',
        message: check.errors.length + ' valeur(s) refusée(s) : aucune écriture.',
        errors: check.errors,
        state: getSchedulerConfigState()
      };
    }

    var before = readConfigMap();
    SCHEDULER_WRITABLE_KEYS.forEach(function (key) {
      setConfigValue(key, check.normalized[key]);
    });
    var after = readConfigMap();
    var changed = SCHEDULER_WRITABLE_KEYS.filter(function (k) {
      return String(before[k]) !== String(after[k]);
    });

    var state = getSchedulerConfigState();
    try {
      logInfo('scheduler', 'Configuration de planification enregistrée', {
        auto_publish: state.autoPublish ? 'TRUE' : 'FALSE',
        mode: state.mode,
        per_week: state.perWeekRaw,
        days: state.days.join(','),
        max_per_run: state.maxPerRunRaw,
        changed: changed.join(',') || '(aucun changement)',
        triggers: state.triggers.count
      });
    } catch (logErr) {
      // Un échec de journalisation ne doit jamais annuler une écriture valide.
      console.error('Journalisation planification impossible : ' + redact(logErr.message));
    }

    return {
      ok: true,
      code: 'SAVED',
      message: 'Configuration enregistrée dans la feuille Config.',
      changed: changed,
      state: state
    };
  } catch (e) {
    return {
      ok: false,
      code: 'SCHED_SAVE_FAILED',
      message: 'Enregistrement impossible : ' + redact(String(e && e.message ? e.message : e)),
      errors: []
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée menu                                                         */
/* -------------------------------------------------------------------------- */

/** Entrée du menu « 🗓️ Planification / Automatisation ». */
function openSchedulerConfigDialog() {
  try {
    SpreadsheetApp.getUi().showModalDialog(
      HtmlService.createHtmlOutput(renderSchedulerDialogHtml(getSchedulerConfigState()))
        .setWidth(640)
        .setHeight(620),
      'Planification / Automatisation'
    );
  } catch (e) {
    // Hors contexte de tableur : on retombe sur le journal, comme showDialog().
    logInfo('scheduler', 'Planification / Automatisation', 'Interface indisponible : ' + redact(e.message));
  }
}

/* -------------------------------------------------------------------------- */
/* Rendu du dialogue                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Phrase d'état RÉELLE (D6-B) : elle décrit le déclencheur du scheduler, pas
 * le nombre brut de déclencheurs du projet — un déclencheur tiers ne doit pas
 * faire croire à une automatisation, ni l'inverse.
 *
 * Elle ne promet jamais plus que ce qui est installé : « armée » n'est pas
 * « en train de s'exécuter ».
 */
function triggerStatusText(triggers) {
  if (!triggers || triggers.readable !== true) {
    return 'État des déclencheurs illisible — automatisation non vérifiable.';
  }

  var n = Number(triggers.schedulerCount);
  if (!isFinite(n) || n < 0) {
    return 'État des déclencheurs illisible — automatisation non vérifiable.';
  }

  if (n === 0) {
    return '0 déclencheur du scheduler — publication automatique INACTIVE.';
  }
  if (n > 1) {
    return n + ' déclencheurs du scheduler — DOUBLON : réinstallez pour n\'en garder qu\'un.';
  }

  var when = (triggers.hour === null || triggers.minute === null)
    ? 'heure illisible'
    : pad2(triggers.hour) + 'h' + pad2(triggers.minute);
  return '1 déclencheur quotidien du scheduler — publication automatique ARMÉE (' +
    when + ', ' + (triggers.timeZone || 'fuseau configuré') +
    '), publication les jours de PUBLISH_DAYS uniquement.';
}

/**
 * Construit le HTML. Toutes les valeurs proviennent de la feuille `Config` et
 * passent par `escHtml()`. Le bouton d'enregistrement appelle
 * `saveSchedulerConfig()` : aucune écriture directe depuis le client.
 */
function renderSchedulerDialogHtml(state) {
  var s = state || getSchedulerConfigState();
  var days = normalizePublishDays(s.days);
  var clock = s.clock || { ok: false, hour: null, minute: null, message: '' };

  var dayBoxes = PUBLISH_DAY_ORDER.map(function (d) {
    var checked = days.indexOf(d) !== -1 ? ' checked' : '';
    return '<label class="day" data-day-label="' + d + '" style="display:inline-flex;' +
      'align-items:center;gap:4px;margin:0 12px 4px 0;cursor:pointer">' +
      '<input type="checkbox" data-day="' + d + '"' + checked + '> ' +
      escHtml(PUBLISH_DAY_LABELS[d]) + '</label>';
  }).join('');

  var modeOptions = SCHEDULER_MODES.map(function (m) {
    var sel = m === s.mode ? ' selected' : '';
    return '<option value="' + escHtml(m) + '"' + sel + '>' + escHtml(m) + '</option>';
  }).join('');

  // PUBLISH_HOUR / PUBLISH_MINUTE restent hors du périmètre d'écriture du
  // dialogue (comme TIMEZONE) : aucune heure par défaut n'est inventée.
  var clockText = clock.ok ? (pad2(clock.hour) + 'h' + pad2(clock.minute)) : '— non renseignée —';
  var clockWarning = clock.ok
    ? ''
    : '<span style="color:#c5221f">' + escHtml(clock.message || '') + '</span>';

  var html = [
    '<div style="font-family:Roboto,Arial,sans-serif;font-size:13px;color:#202124">',
    '<h3 style="margin:0 0 4px">Planification / Automatisation</h3>',
    '<p id="automationStatus" style="margin:0 0 12px;padding:6px 8px;border-radius:4px;' +
      'background:#fef7e0;color:#8a6d3b;font-weight:600">' +
      escHtml(triggerStatusText(s.triggers)) + '</p>',

    '<p style="margin:0 0 10px;color:#5f6368">' +
      'Ces réglages sont enregistrés dans la feuille <b>Config</b>. Un ' +
      '<b>unique</b> déclencheur quotidien appelle le moteur : il sonne tous les ' +
      'jours et ne publie que les jours cochés ci-dessus, si ' +
      '<b>Publication automatique</b> est cochée et si le nombre d\'articles ' +
      'prévus est divisible par le nombre de jours.</p>',

    '<p style="margin:0 0 10px">' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:600">' +
      '<input type="checkbox" id="autoPublish"' + (s.autoPublish ? ' checked' : '') + '> ' +
      'Publication automatique</label></p>',

    '<p style="margin:0 0 10px">' +
      '<label for="mode" style="display:block;margin-bottom:4px;font-weight:600">Mode</label>' +
      '<select id="mode" style="width:100%;padding:4px">' + modeOptions + '</select>' +
      '<span style="color:#5f6368;font-size:12px">Seul mode supporté : ' +
      escHtml(SCHEDULER_MODES.join(', ')) + '.</span></p>',

    '<p style="margin:0 0 10px">' +
      '<label for="perWeek" style="display:block;margin-bottom:4px;font-weight:600">' +
      'Articles par semaine</label>' +
      '<input type="number" id="perWeek" min="1" max="' + SCHEDULER_MAX_ARTICLES_PER_WEEK +
      '" step="1" value="' + escHtml(s.perWeekRaw) + '" style="width:120px;padding:4px"></p>',

    '<fieldset id="daysBox" style="border:1px solid #dadce0;border-radius:4px;padding:8px 10px;margin:0 0 10px">' +
      '<legend style="font-weight:600;padding:0 4px">Jours de publication</legend>' + dayBoxes + '</fieldset>',

    '<p style="margin:0 0 10px">' +
      '<label for="maxPerRun" style="display:block;margin-bottom:4px;font-weight:600">' +
      'Articles maximum par exécution</label>' +
      '<input type="number" id="maxPerRun" min="1" max="' + SCHEDULER_MAX_ARTICLES_PER_RUN +
      '" step="1" value="' + escHtml(s.maxPerRunRaw) + '" style="width:120px;padding:4px">' +
      '<span style="color:#5f6368;font-size:12px">Plafond d\'une exécution : ' +
      'le nombre réellement publié est le plus petit entre ce plafond et le ' +
      'quotidien (articles par semaine ÷ nombre de jours).</span></p>',

    '<p style="margin:0 0 4px;color:#5f6368">Fuseau horaire (lecture seule) : ' +
      '<b>' + escHtml(s.timeZone) + '</b> — aligné sur le manifeste.</p>',

    '<p style="margin:0 0 10px;color:#5f6368">Heure de publication (lecture seule, feuille Config) : ' +
      '<b>' + escHtml(clockText) + '</b> — clés <code>PUBLISH_HOUR</code> et ' +
      '<code>PUBLISH_MINUTE</code>. <b>Aucune heure par défaut</b> : tant que ces ' +
      'deux clés ne sont pas renseignées dans la feuille <b>Config</b>, le bouton ' +
      '« Installer » est refusé. ' + clockWarning + '</p>',

    '<p id="summary" aria-live="polite" style="margin:0 0 10px;padding:8px;' +
      'background:#e8f0fe;border-radius:4px;color:#174ea6"></p>',

    '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px">' +
      '<button type="button" id="installTriggerBtn" style="padding:6px 12px">' +
      'Installer / mettre à jour le déclencheur</button>' +
      '<button type="button" id="removeTriggerBtn" style="padding:6px 12px">' +
      'Retirer le déclencheur</button>' +
      '<button type="button" id="statusTriggerBtn" style="padding:6px 12px">' +
      'État du déclencheur</button>' +
    '</div>',

    '<div id="result" role="status" aria-live="polite" style="margin:0 0 10px;min-height:18px;color:#5f6368"></div>',

    '<div style="display:flex;justify-content:flex-end;gap:8px">' +
      '<button type="button" id="cancelBtn" style="padding:6px 14px">Annuler</button>' +
      '<button type="button" id="saveBtn" style="padding:6px 14px;font-weight:600">Enregistrer</button>',
    '</div>',
    '</div>',
    schedulerClientScript()
  ].join('');

  return html;
}

/** Script client : résumé vivant, contrôle miroir, appel `saveSchedulerConfig`. */
function schedulerClientScript() {
  var lines = [
    '<script>',
    'var DAYS=' + JSON.stringify(PUBLISH_DAY_ORDER) + ';',
    'var MAX_WEEK=' + SCHEDULER_MAX_ARTICLES_PER_WEEK + ';',
    'var MAX_RUN=' + SCHEDULER_MAX_ARTICLES_PER_RUN + ';',
    'function el(id){return document.getElementById(id);}',
    'function isInt(v){return /^[0-9]+$/.test(String(v).trim());}',
    'function selectedDays(){',
    '  var out=[];',
    '  DAYS.forEach(function(d){',
    '    var b=document.querySelector("input[data-day=\'"+d+"\']");',
    '    if(b&&b.checked)out.push(d);',
    '  });',
    '  return out;',
    '}',
    'function dayLabel(d){',
    '  var n=document.querySelector("label[data-day-label=\'"+d+"\']");',
    '  return n?n.textContent:d;',
    '}',
    'function plural(n,word){return n+" "+word+(n>1?"s":"");}',
    'function summarize(){',
    '  var days=selectedDays();',
    '  var raw=el("perWeek").value.trim();',
    '  var n=Number(raw);',
    '  var parts=[];',
    '  if(isInt(raw)&&n>=1)parts.push(plural(n,"article")+" / semaine");',
    '  else parts.push("—");',
    '  if(days.length)parts.push(days.map(dayLabel).join(" + "));',
    '  else parts.push("Aucun jour sélectionné");',
    '  if(isInt(raw)&&n>=1&&days.length){',
    '    var per=n/days.length;',
    '    if(per===Math.floor(per)){',
    '      days.forEach(function(d){parts.push(plural(per,"article")+" "+dayLabel(d).toLowerCase());});',
    '    }else{',
    '      parts.push("Répartition impossible : "+n+" ne se divise pas exactement sur "+days.length+" jour(s).");',
    '    }',
    '  }',
    '  el("summary").textContent=parts.join(" · ");',
    '}',
    'function validate(){',
    '  var e=[];',
    '  var days=selectedDays();',
    '  var raw=el("perWeek").value.trim();',
    '  var n=Number(raw);',
    '  if(!isInt(raw)||n<1||n>MAX_WEEK)e.push({c:"SCHED_PER_WEEK",m:"Articles par semaine : entier entre 1 et "+MAX_WEEK+" attendu."});',
    '  if(isInt(raw)&&n>0&&days.length===0)e.push({c:"SCHED_DAYS_EMPTY",m:"Sélectionnez au moins un jour de publication."});',
    '  if(days.length&&isInt(raw)&&n>0&&n%days.length!==0)e.push({c:"SCHED_DISTRIBUTION",m:"Articles par semaine ("+n+") ne se répartit pas également sur "+days.length+" jour(s) : un multiple de "+days.length+" est requis."});',
    '  var mraw=el("maxPerRun").value.trim();',
    '  var m=Number(mraw);',
    '  if(!isInt(mraw)||m<1||m>MAX_RUN)e.push({c:"SCHED_MAX_PER_RUN",m:"Articles maximum par exécution : entier entre 1 et "+MAX_RUN+" attendu."});',
    '  return e;',
    '}',
    'function clearInvalid(){',
    '  [el("perWeek"),el("maxPerRun"),el("daysBox")].forEach(function(n){if(n)n.removeAttribute("aria-invalid");});',
    '}',
    'function markInvalid(errs){',
    '  clearInvalid();',
    '  errs.forEach(function(e){',
    '    var n=null;',
    '    if(e.c==="SCHED_PER_WEEK")n=el("perWeek");',
    '    else if(e.c==="SCHED_MAX_PER_RUN")n=el("maxPerRun");',
    '    else n=el("daysBox");',
    '    if(n)n.setAttribute("aria-invalid","true");',
    '  });',
    '}',
    'function say(kind,text){',
    '  var n=el("result");',
    '  if(!n)return;',
    '  n.textContent=text;',
    '  n.style.color=kind==="ok"?"#137333":(kind==="ko"?"#c5221f":"#5f6368");',
    '}',
    'function applyTriggerStatus(t){',
    '  var n=el("automationStatus");',
    '  if(!n||!t)return;',
    '  if(t.readable!==true){n.textContent="État des déclencheurs illisible — automatisation non vérifiable.";return;}',
    '  var k=Number(t.schedulerCount);',
    '  if(!(k>=0)){n.textContent="État des déclencheurs illisible — automatisation non vérifiable.";return;}',
    '  if(k===0){n.textContent="0 déclencheur du scheduler — publication automatique INACTIVE.";return;}',
    '  if(k>1){n.textContent=k+" déclencheurs du scheduler — DOUBLON : réinstallez pour n’en garder qu’un.";return;}',
    '  var when=(t.hour===null||t.hour===undefined||t.minute===null||t.minute===undefined)',
    '    ?"heure illisible"',
    '    :("0"+t.hour).slice(-2)+"h"+("0"+t.minute).slice(-2);',
    '  n.textContent="1 déclencheur quotidien du scheduler — publication automatique ARMÉE ("+when+", "+(t.timeZone||"fuseau configuré")+"), publication les jours de PUBLISH_DAYS uniquement.";',
    '}',
// D6-B : les 3 actions de déclencheur passent par le dialogue existant.
// Aucune entrée de menu supplémentaire n'est ajoutée.
'function onTriggerResult(res){',
    '  ["installTriggerBtn","removeTriggerBtn","statusTriggerBtn"].forEach(function(id){',
    '    var b=el(id);if(b)b.disabled=false;',
    '  });',
    '  say(res&&res.ok===false?"ko":"ok",(res&&res.message)||(res&&res.code)||"Fait.");',
    '  if(res&&res.triggers)applyTriggerStatus(res.triggers);',
    '  else if(res&&res.state)applyTriggerStatus(res.state.triggers);',
    '}',
'function onTriggerError(err){',
    '  ["installTriggerBtn","removeTriggerBtn","statusTriggerBtn"].forEach(function(id){',
    '    var b=el(id);if(b)b.disabled=false;',
    '  });',
    '  say("ko",String(err&&err.message?err.message:err));',
    '}',
'function installTrigger(){',
    '  el("installTriggerBtn").disabled=true;',
    '  say("busy","Installation du déclencheur…");',
    '  google.script.run',
    '    .withSuccessHandler(onTriggerResult)',
    '    .withFailureHandler(onTriggerError)',
    '    .installSchedulerTrigger();',
    '}',
'function removeTrigger(){',
    '  el("removeTriggerBtn").disabled=true;',
    '  say("busy","Retrait du déclencheur…");',
    '  google.script.run',
    '    .withSuccessHandler(onTriggerResult)',
    '    .withFailureHandler(onTriggerError)',
    '    .removeSchedulerTrigger();',
    '}',
'function refreshTriggerStatus(){',
    '  el("statusTriggerBtn").disabled=true;',
    '  say("busy","Lecture de l\'état…");',
    '  google.script.run',
    '    .withSuccessHandler(onTriggerResult)',
    '    .withFailureHandler(onTriggerError)',
    '    .getSchedulerTriggerStatus();',
    '}',

    'function save(){',
    '  var errs=validate();',
    '  clearInvalid();',
    '  if(errs.length){markInvalid(errs);say("ko",errs.map(function(e){return e.m;}).join(" "));return;}',
    '  var btn=el("saveBtn");',
    '  btn.disabled=true;',
    '  say("busy","Enregistrement…");',
    '  google.script.run',
    '    .withSuccessHandler(onSaved)',
    '    .withFailureHandler(function(err){btn.disabled=false;say("ko",String(err&&err.message?err.message:err));})',
    '    .saveSchedulerConfig({',
    '      autoPublish:el("autoPublish").checked,',
    '      mode:el("mode").value,',
    '      perWeek:el("perWeek").value,',
    '      days:selectedDays(),',
    '      maxPerRun:el("maxPerRun").value',
    '    });',
    '}',
    'function onSaved(res){',
    '  if(!res||res.ok!==true){',
    '    el("saveBtn").disabled=false;',
    '    var msg=res&&res.message?res.message:"Enregistrement refusé.";',
    '    var list=res&&res.errors&&res.errors.length?res.errors.map(function(e){return e.message;}).join(" "):"";',
    '    if(res&&res.errors)markInvalid(res.errors);',
    '    say("ko",(msg+" "+list).trim());',
    '    return;',
    '  }',
    '  say("ok",res.message);',
    '  var st=res.state;',
    '  if(st){',
    '    el("autoPublish").checked=st.autoPublish===true;',
    '    el("mode").value=st.mode;',
    '    el("perWeek").value=st.perWeekRaw;',
    '    el("maxPerRun").value=st.maxPerRunRaw;',
    '    DAYS.forEach(function(d){var b=document.querySelector("input[data-day=\'"+d+"\']");if(b)b.checked=st.days.indexOf(d)!==-1;});',
    '    applyTriggerStatus(st.triggers);',
    '  }',
    '  summarize();',
    '}',
    'function boot(){',
    '  ["autoPublish","mode","perWeek","maxPerRun"].forEach(function(id){',
    '    var n=el(id);',
    '    if(n)n.addEventListener("change",function(){clearInvalid();summarize();});',
    '    if(n)n.addEventListener("input",function(){clearInvalid();summarize();});',
    '  });',
    '  DAYS.forEach(function(d){',
    '    var b=document.querySelector("input[data-day=\'"+d+"\']");',
    '    if(b)b.addEventListener("change",function(){clearInvalid();summarize();});',
    '  });',
    '  el("saveBtn").addEventListener("click",save);',
    '  el("cancelBtn").addEventListener("click",function(){google.script.host.close();});',
    // D6-B : les 3 boutons sont réactivés après chaque réponse (succès ou échec).
    '  el("installTriggerBtn").addEventListener("click",installTrigger);',
    '  el("removeTriggerBtn").addEventListener("click",removeTrigger);',
    '  el("statusTriggerBtn").addEventListener("click",refreshTriggerStatus);',
    '  summarize();',
    '}',
    'boot();',
    '</script>'
  ];
  return lines.join('\n');
}
