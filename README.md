<p align="center">
  <img src="src/assets/kilo.svg" width="128" alt="Kilo, la mascotte de KiloNote">
</p>

<h1 align="center">KiloNote</h1>

<p align="center"><em>Des notes légères comme un kilooctet.</em></p>

KiloNote est un éditeur de notes pour Windows, macOS et Linux, dans l'esprit de Sublime Text :
sobre, rapide, entièrement au clavier, et pensé pour **suivre ses tâches de travail** et en
garder l'historique. Vos notes restent de simples fichiers texte, lisibles partout.

Sa mascotte s'appelle **Kilo** : une petite note avec un bit en guise d'antenne.

![KiloNote, thème Minuit : vue des tâches, groupe d'onglets « Projet MC »](docs/apercu-sombre.png)

<details>
<summary>Thème clair « Papier »</summary>

![KiloNote, thème Papier](docs/apercu-clair.png)

</details>

---

## Fonctionnalités

**Éditeur**
- Rapide même sur de gros fichiers (CodeMirror 6), multi-curseurs (Ctrl+D, Alt+clic), sélection en colonne
- Coloration des notes : titres `#`, puces, liens cliquables (Ctrl+clic), dates, `#tags`, `@mentions`
- Markdown et JSON colorés ; encodages UTF-8, Windows-1252 et UTF-16 reconnus, fins de ligne LF/CRLF conservées
- Enregistrement automatique, écriture atomique, onglets non enregistrés conservés entre deux sessions
- Rechargement automatique quand un autre programme modifie une note ouverte

**Tâches**
- Une tâche est une ligne qui se termine par ` - <statut>` : `- appeler collègue X - todo`
- **Ctrl+Entrée** fait tourner le statut : `todo` → `ongoing` → `done` (sur une ou plusieurs lignes)
- **Clic sur un statut** : menu pour le changer ou archiver la tâche
- **Ctrl+Maj+Entrée** archive la tâche dans `<projet>_done.txt`, datée : `- appeler collègue X - done [2026-11-02]`
- Vue **Tâches** : toutes les tâches de toutes vos notes, celles en cours d'abord
- **Bilan d'activité** : résumé de l'année par projet et par mois, prêt à présenter à son manager

**Organisation**
- Onglets colorés et **groupes d'onglets** nommés, colorés et repliables ; glisser-déposer
- Explorateur de dossier, recherche floue de fichiers (Ctrl+P), recherche dans tous les fichiers (Ctrl+Maj+F)
- Palette de commandes (Ctrl+Maj+P), aller à un titre ou une tâche (Ctrl+R), à une ligne (Ctrl+G)

**Personnalisation**
- 6 thèmes (Minuit, Papier, Forêt, Océan, Sable, Rétro) ou automatique selon le système
- Couleur d'accent, surcharge de chaque couleur, police, taille, interligne
- Statuts de tâches, couleurs, cycle, suffixe d'archive, raccourcis clavier : tout est dans un `settings.json` commenté
- Mode zen (Maj+F11), plein écran (F11)

## Le suivi des tâches au quotidien

```text
mc.txt                                         mc_done.txt
──────                                         ───────────
# Projet MC                                    - mettre en place la CI - done [2026-01-15]
- appeler collègue X - todo        Ctrl+Maj+   - migrer la base - ok [2026-03-02]
- relire la spec - ongoing         Entrée ──►  - appeler collègue X - done [2026-11-02]
```

1. Écrivez la tâche, puis **Ctrl+Entrée** : ` - todo` est ajouté (sur une ligne vide, une tâche vierge est préparée).
2. Quand vous commencez : **Ctrl+Entrée** → `ongoing`.
3. Quand c'est fini : **Ctrl+Maj+Entrée** → la ligne part dans `mc_done.txt` avec la date du jour.
   **Ctrl+Maj+D** bascule entre `mc.txt` et `mc_done.txt`.
4. En fin d'année : palette → **Bilan : générer le bilan d'activité**.

Les statuts `todo`, `ongoing`, `blocked`, `wait`, `done`, `ok` sont reconnus par défaut, en
majuscules ou minuscules. Vos fichiers existants fonctionnent tels quels.

## Installation

### Installeurs

Les installeurs sont produits automatiquement par GitHub Actions (onglet *Releases* du dépôt) :

| Système | Fichier | Remarque |
|---|---|---|
| Windows 10/11 | `KiloNote_x.y.z_x64-setup.exe` | s'installe **sans droits administrateur** |
| macOS (Intel et Apple Silicon) | `KiloNote_x.y.z_universal.dmg` | |
| Linux | `.AppImage` (portable), `.deb`, `.rpm` | |

L'application n'étant pas signée numériquement :
- **Windows** : si SmartScreen s'affiche, cliquez sur *Informations complémentaires* → *Exécuter quand même*.
- **macOS** : la première fois, clic droit sur KiloNote → *Ouvrir* (ou `xattr -cr /Applications/KiloNote.app`).

Pour publier une version : mettez à jour la version dans `src-tauri/tauri.conf.json` et `package.json`,
puis `git tag v0.1.0 && git push --tags`. Une release brouillon est créée avec les installeurs.

### Depuis les sources

Prérequis : [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) stable, et les
[dépendances système de Tauri](https://tauri.app/start/prerequisites/) :

- **Windows** : Microsoft C++ Build Tools (WebView2 est déjà présent sur Windows 10/11)
- **macOS** : `xcode-select --install`
- **Debian/Ubuntu** : `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

```bash
npm install
npm run app:dev      # lance l'application en mode développement
npm run app:build    # produit l'installeur dans src-tauri/target/release/bundle/
```

On peut aussi passer un dossier ou un fichier en argument : `kilonote ~/notes` ou `kilonote mc.txt`.

## Raccourcis

Sur macOS, Ctrl devient ⌘.

| Action | Raccourci |
|---|---|
| Tâche : statut suivant | **Ctrl+Entrée** |
| Tâche : archiver dans `_done` | **Ctrl+Maj+Entrée** |
| Basculer note ↔ archive | Ctrl+Maj+D |
| Vue des tâches | Ctrl+Maj+A |
| Aller au fichier | Ctrl+P (`:` ligne, `@` titres/tâches, `>` commandes) |
| Palette de commandes | Ctrl+Maj+P ou F1 |
| Aller à un titre / une tâche | Ctrl+R |
| Aller à la ligne | Ctrl+G |
| Rechercher / remplacer | Ctrl+F / Ctrl+H |
| Rechercher dans le dossier | Ctrl+Maj+F |
| Nouvelle note / ouvrir / dossier | Ctrl+N / Ctrl+O / Ctrl+Maj+O |
| Enregistrer / sous | Ctrl+S / Ctrl+Maj+S |
| Fermer / rouvrir un onglet | Ctrl+W / Ctrl+Maj+T |
| Onglet suivant / n°X | Ctrl+Tab / Ctrl+1…9 |
| Barre latérale / explorateur | Ctrl+B / Ctrl+Maj+E |
| Taille du texte | Ctrl+= / Ctrl+- / Ctrl+0 (ou Ctrl+molette) |
| Paramètres | Ctrl+, |
| Mode zen / plein écran | Maj+F11 / F11 |
| Sélectionner l'occurrence suivante | Ctrl+D |
| Déplacer / supprimer la ligne | Alt+↑↓ / Ctrl+Maj+K |

Tous les raccourcis se redéfinissent dans `settings.json` :

```jsonc
"keybindings": {
  "Ctrl+T": "task.cycle",     // id visible dans la palette de commandes
  "Ctrl+Maj+Enter": ""        // une valeur vide désactive le raccourci
}
```

## Personnalisation

**Ctrl+,** ouvre `settings.json`. Chaque option y est documentée ; l'enregistrement applique
les changements immédiatement. Exemples :

```jsonc
{
  "theme": "papier",
  "accent": "#e8590c",
  "colors": { "bg": "#fffdf8" },
  "font_family": "Cascadia Code, monospace",
  "task_statuses": { "todo": "blue", "ongoing": "orange", "attente": "purple", "done": "green", "ok": "green" },
  "task_cycle": ["todo", "ongoing", "done"],
  "archive_suffix": "_done",
  "archive_status": "ok",
  "archive_date": true
}
```

Emplacement du fichier : `%APPDATA%\dev.damoy.kilonote\` (Windows),
`~/Library/Application Support/dev.damoy.kilonote/` (macOS), `~/.config/dev.damoy.kilonote/` (Linux).

## Développement

```bash
npm run dev     # interface seule dans le navigateur, avec des notes de démonstration
npm test        # tests unitaires (tâches, bilan, chemins, paramètres…)
npm run build   # vérification des types + build du front
```

Architecture :

```
src/
  core/         backend (Tauri ou démo navigateur), chemins, paramètres, thèmes, commandes
  editor/       CodeMirror : tâches (logique pure), coloration des notes, configuration
  ui/           onglets et groupes, barre latérale, palette, menus, barre d'état, accueil
  app.ts        contrôleur : documents, enregistrement, session, commandes
  report.ts     bilan d'activité
src-tauri/      backend natif Rust : lecture/écriture atomique, archives, corbeille
```

Choix techniques : [Tauri 2](https://tauri.app) (fenêtre native, ~10 Mo au lieu de ~150 Mo pour
Electron), [CodeMirror 6](https://codemirror.net) pour l'éditeur, aucun framework d'interface.
