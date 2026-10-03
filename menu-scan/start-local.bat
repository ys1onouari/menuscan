@echo off
rem ==============================================================
rem  Menu Scan - Demarrage du serveur local - npm run dev
rem  Fichier : start-local.bat
rem  Lance le serveur Vite sur http://localhost:3000
rem  et ouvre le navigateur une fois le serveur pret.
rem
rem  Note : aucune parenthese dans les textes echo, afin d'eviter
rem  que le parseur de cmd casse les blocs if.
rem ==============================================================

setlocal EnableExtensions EnableDelayedExpansion
title Menu Scan - Serveur local

rem --- 1. Se placer dans le dossier du projet - gere les espaces ---
cd /d "%~dp0"

set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo.
echo  ==============================================================
echo     MENU SCAN - SERVEUR LOCAL
echo  ==============================================================
echo.
echo   Dossier du projet : "%CD%"
echo   URL locale        : %URL%
echo.

rem --- 2. Verifier que Node.js et npm sont disponibles ---
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERREUR] Node.js est introuvable dans le PATH.
    echo           Installez Node.js depuis https://nodejs.org
    echo           puis relancez ce script.
    echo.
    goto :erreur
)

where npm >nul 2>&1
if errorlevel 1 (
    echo  [ERREUR] npm est introuvable dans le PATH.
    echo           Reinstallez Node.js - npm est livre avec Node.js
    echo           puis relancez ce script.
    echo.
    goto :erreur
)

for /f "tokens=*" %%v in ('node --version') do set "NODE_VERSION=%%v"
for /f "tokens=*" %%v in ('npm --version') do set "NPM_VERSION=%%v"
echo  [OK] Node.js detecte : %NODE_VERSION%
echo  [OK] npm detecte     : %NPM_VERSION%
echo.

rem --- 3. Verifier que les dependances sont installees ---
if exist "node_modules" goto :dependances_ok

echo  [INFO] Les dependances ne sont pas installees.
echo.
choice /c ON /n /m "        Lancer 'npm install' maintenant ? [O/N] : "
if errorlevel 2 goto :install_annulee

echo.
echo  Installation des dependances en cours, merci de patienter...
echo.
call npm install
if errorlevel 1 goto :install_echoue

echo.
echo  [OK] Dependances installees.
echo.
goto :verif_port

:install_annulee
echo.
echo  [INFO] Installation annulee.
echo         Executez 'npm install' puis relancez ce script.
echo.
goto :erreur

:install_echoue
echo.
echo  [ERREUR] Echec de 'npm install'.
echo.
goto :erreur

:dependances_ok
echo  [OK] Dependances deja installees - dossier node_modules present.
echo.
goto :verif_port

rem --- 4. Ne pas lancer une deuxieme instance si le port est occupe ---
:verif_port
call :port_occupe
if "!PORT_UTILISE!"=="1" goto :deja_lance

rem --- 5. Lancer le serveur de developpement dans une fenetre dediee ---
echo  Demarrage du serveur de developpement...
echo  Le serveur s'affiche dans une deuxieme fenetre.
echo.
start "Menu Scan - serveur Vite" /D "%CD%" cmd /k "npm run dev"

rem --- 6. Attendre que le port reponde ---
set /a ATTENTE=0
:attente
call :port_occupe
if "!PORT_UTILISE!"=="1" goto :serveur_pret

set /a ATTENTE+=1
if !ATTENTE! GEQ 30 goto :delai_depasse

ping -n 2 127.0.0.1 >nul
goto :attente

:delai_depasse
echo.
echo  [ERREUR] Le serveur n'a pas demarre apres 30 secondes.
echo           Lisez le message dans la fenetre du serveur.
echo.
goto :erreur

rem --- Serveur pret : ouvrir le navigateur ---
:serveur_pret
echo.
echo  ==============================================================
echo     SERVEUR PRET
echo  ==============================================================
echo.
echo   Ouvrez cette adresse dans votre navigateur :
echo.
echo     %URL%
echo.
echo   Pour arreter le serveur : fermez la fenetre du serveur
echo   ou appuyez sur Ctrl+C dedans.
echo.
echo  Ouverture du navigateur...
start "" "%URL%"
echo.
echo  [OK] Navigateur ouvert sur %URL%
echo.
echo  Appuyez sur une touche pour fermer cette fenetre...
pause >nul
goto :fin

rem --- Le port etait deja occupe : on ouvre seulement le navigateur ---
:deja_lance
echo  [INFO] Un serveur ecoute deja sur le port %PORT%.
echo         Aucune nouvelle instance n'est lancee.
echo.
echo  Ouverture de %URL% dans le navigateur...
start "" "%URL%"
echo.
echo  [OK] Navigateur ouvert sur %URL%
echo.
echo  Appuyez sur une touche pour fermer cette fenetre...
pause >nul
goto :fin

rem --- Erreur : la fenetre reste ouverte pour lire le message ---
:erreur
echo  ==============================================================
echo     ECHEC - voir le message ci-dessus
echo  ==============================================================
echo.
echo  Cette fenetre reste ouverte pour que vous puissiez lire le message.
echo.
pause
goto :fin

:fin
endlocal
exit /b 0

rem ==============================================================
rem  Sous-programme : detecte si le port %PORT% est en ecoute.
rem  Definit PORT_UTILISE a 1 si occupe, 0 si libre.
rem ==============================================================
:port_occupe
set "PORT_UTILISE=0"
netstat -ano | findstr /c:":%PORT% " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 set "PORT_UTILISE=1"
goto :eof
