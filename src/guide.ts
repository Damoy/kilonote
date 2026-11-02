// Guide affiché par la commande « Aide : guide de KiloNote ».

export const GUIDE = `# Bienvenue dans KiloNote

KiloNote est un éditeur de notes **léger et rapide**, pensé pour suivre ses tâches
et garder une trace de son travail. Tout est stocké dans de simples fichiers texte.

## Les tâches

Une tâche est une ligne qui se termine par \` - <statut>\` :

- appeler collègue X - todo
- préparer la démo client - ongoing
- corriger le bug d'export - blocked
- relire la spec - done

Raccourcis :

- **Ctrl+Entrée** : transforme la ligne en tâche, puis fait tourner son statut
  (todo → ongoing → done). Fonctionne sur plusieurs lignes sélectionnées.
- **Clic sur un statut** : menu pour choisir le statut ou archiver.
- **Ctrl+Maj+Entrée** : archive la tâche dans le fichier d'archive du projet.
  Pour \`mc.txt\`, la ligne part dans \`mc_done.txt\` (créé si besoin), avec la date :
  \`- appeler collègue X - done [2026-11-02]\`
- **Ctrl+Maj+D** : bascule entre \`mc.txt\` et \`mc_done.txt\`.
- Palette → « Tâche : archiver toutes les tâches terminées ».

La vue **Tâches** (Ctrl+Maj+A) liste les tâches de toutes les notes du dossier ouvert,
avec celles en cours en premier. Survolez une tâche pour changer son statut ou l'archiver.

## Le bilan d'activité

Palette → « Bilan : générer le bilan d'activité… ». KiloNote lit tous les fichiers
\`*_done\` du dossier et produit un résumé par projet et par mois, prêt à être copié
pour un entretien annuel. Les tâches en cours y figurent aussi.

## Onglets et groupes

- Clic droit sur un onglet : couleur, groupe, fermer les autres…
- Les **groupes d'onglets** ont un nom et une couleur ; cliquez sur l'étiquette pour
  replier ou déplier le groupe. Glissez un onglet pour le déplacer.
- Ctrl+1…9 : aller à l'onglet n°X. Ctrl+Tab : onglet suivant.
- Ctrl+Maj+T : rouvrir le dernier onglet fermé.

## Navigation

- **Ctrl+P** : aller à un fichier du dossier (recherche floue).
  - \`:42\` aller à la ligne 42, \`@\` titres et tâches, \`>\` commandes.
- **Ctrl+Maj+P** : palette de commandes.
- **Ctrl+Maj+F** : rechercher dans tous les fichiers.
- **Ctrl+F** / **Ctrl+H** : rechercher / remplacer dans la note.
- **Ctrl+D** : sélectionner l'occurrence suivante (multi-curseurs), **Alt+clic** : curseur supplémentaire.
- **Alt+↑ / Alt+↓** : déplacer la ligne. **Ctrl+Maj+K** : supprimer la ligne.

## Personnalisation

**Ctrl+,** ouvre \`settings.json\` (commenté) : thème, couleurs, police, statuts de tâches
et leurs couleurs, suffixe d'archive, raccourcis… Enregistrez : tout s'applique aussitôt.

- Thèmes : Minuit, Papier, Forêt, Océan, Sable, Rétro (ou automatique).
- Palette → « Thème : couleur d'accent… » pour changer la couleur principale.
- Ctrl+= / Ctrl+- : taille du texte. Maj+F11 : mode zen. Ctrl+B : barre latérale.

## Sécurité de vos notes

- Enregistrement automatique après une courte pause (désactivable).
- Écriture atomique : un fichier n'est jamais à moitié écrit.
- Les onglets non enregistrés sont conservés d'une session à l'autre.
- Si un autre programme modifie une note ouverte, KiloNote la recharge (ou vous prévient).
- La suppression passe par la corbeille du système.

Bonne prise de notes ! — Kilo
`;
