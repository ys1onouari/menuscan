/**
 * Menu Scan — Debug utilitaire (lecture seule, n'écrit rien, n'affiche aucun secret).
 * Exécuter debugTemplate puis ouvrir « Journaux d'exécution ».
 */
function debugTemplate() {
  console.log('owner=[' + propGet('GITHUB_OWNER') + '] repo=[' + propGet('GITHUB_REPOSITORY') +
    '] branch=[' + propGet('GITHUB_BRANCH') + '] prefix=[' + propGet('GITHUB_PATH_PREFIX') + ']');
  console.log('getGithubPathPrefix=' + typeof getGithubPathPrefix + ' repoPath=' + typeof repoPath);
  console.log('token configuré=' + !!propGet('GITHUB_TOKEN'));
  var file = getFile(APP.TEMPLATE_PATH);
  console.log(file
    ? 'GABARIT TROUVÉ : ' + file.path + ' (' + file.size + ' octets)'
    : 'GABARIT INTROUVABLE : ' + repoPath(APP.TEMPLATE_PATH));
}
