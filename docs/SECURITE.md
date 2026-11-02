# KiloNote — fiche sécurité

Document destiné à un service informatique ou sécurité qui doit évaluer KiloNote avant son
utilisation sur un poste de travail. Chaque point est vérifiable dans le code source.

## En bref

| Question | Réponse |
|---|---|
| Nature | Éditeur de fichiers texte local (équivalent fonctionnel de Notepad++ / Sublime Text) |
| Accès réseau | **Aucun.** Pas de client HTTP compilé, pas de télémétrie, pas de mise à jour automatique |
| Données | Fichiers texte choisis par l'utilisateur, sur le disque local, en clair (comme Notepad) |
| Droits | **Utilisateur standard.** Aucun droit administrateur, aucun service, aucun lancement au démarrage |
| Moteur d'affichage | Microsoft Edge WebView2 (composant de Windows 10/11, mis à jour par Windows Update) |
| Code source | Disponible ; dépendances open source répandues (Tauri, CodeMirror) |
| Signature | **Non signé** (pas de certificat Authenticode) : voir « Points d'attention » |

## Réseau

- Le binaire ne contient aucune bibliothèque de requêtes HTTP : `cargo tree -e normal -i reqwest`
  ne renvoie rien, quel que soit le système cible.
- L'interface est soumise à une politique de sécurité de contenu stricte
  (`src-tauri/tauri.conf.json`) : `connect-src 'self' ipc:` interdit toute requête vers
  l'extérieur, `script-src 'self'` interdit tout script distant. Polices et images sont
  intégrées à l'application.
- Seule action liée au réseau : Ctrl+clic sur un lien dans une note l'ouvre dans le
  navigateur par défaut, à l'initiative de l'utilisateur.
- L'installeur peut télécharger WebView2 auprès de Microsoft **uniquement s'il est absent**
  (il est présent d'office sur Windows 10/11).

## Fichiers et registre

| Emplacement | Contenu |
|---|---|
| `%LOCALAPPDATA%\KiloNote\` | programme (`kilonote.exe`, `uninstall.exe`) |
| `%APPDATA%\dev.damoy.kilonote\` | paramètres (`settings.json`), session (onglets ouverts), position de la fenêtre |
| `%LOCALAPPDATA%\dev.damoy.kilonote\` | cache du moteur WebView2 |
| `HKCU\…\Uninstall\KiloNote` | entrée « Programmes et fonctionnalités » |
| Menu Démarrer, Bureau | raccourcis |

- KiloNote ne lit et n'écrit que les fichiers et dossiers que l'utilisateur ouvre, plus les
  fichiers d'archive `<nom>_done.txt` qu'il crée à côté, à la demande.
- Les suppressions passent par la corbeille Windows.
- La session peut contenir le texte des onglets non enregistrés (pour ne rien perdre en cas
  de fermeture) : désactivable avec `"hot_exit": false` dans les paramètres.
- Désinstallation complète : « Programmes et fonctionnalités » puis suppression des deux
  dossiers `dev.damoy.kilonote`.

## Surface technique

- Interface web exécutée dans WebView2, isolée du système : elle ne peut appeler qu'une
  liste fermée de commandes natives déclarées dans `src-tauri/src/main.rs` (lire/écrire un
  fichier texte, lister un dossier, renommer, mettre à la corbeille) et les permissions de
  `src-tauri/capabilities/default.json`.
- Le contenu des notes n'est jamais interprété comme du HTML (affichage par éditeur de texte),
  ce qui écarte l'injection de script via un fichier ouvert.
- Outils de développement du navigateur désactivés dans la version distribuée.

## Points d'attention

1. **Exécutable non signé.** SmartScreen peut afficher un avertissement, et un EDR ou une
   politique AppLocker / WDAC / Smart App Control peut bloquer un exécutable inconnu placé
   dans le profil utilisateur. Solutions : autorisation par empreinte SHA-256 (fichier
   `SHA256SUMS.txt` livré avec chaque version), ou signature avec un certificat de
   l'entreprise.
2. **Logiciel hors catalogue.** Même sans droits administrateur, l'installation peut être
   soumise à la charte informatique de l'entreprise.
3. **Construction depuis les sources.** Elle demande Node.js, Rust et les outils de build
   Microsoft, et télécharge des paquets depuis npm et crates.io : il est plus simple de
   valider l'installeur produit par la CI (GitHub Actions) à partir de ces mêmes sources.

## Vérifier un installeur

```powershell
Get-FileHash .\KiloNote_0.1.0_x64-setup.exe -Algorithm SHA256
```

L'empreinte doit correspondre à celle du fichier `SHA256SUMS.txt` de la version.
