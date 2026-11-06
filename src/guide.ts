// Guide shown by the "Help: KiloNote guide" command.

export const GUIDE = `# Welcome to KiloNote

KiloNote is a **light, fast** note-taking editor, built to track tasks and keep a
record of your work. Everything is stored in plain text files.

## Tasks

A task is a line that ends with \` - <status>\`:

- call colleague X - todo
- prepare the client demo - ongoing
- fix the export bug - blocked
- review the spec - done

Shortcuts:

- **Ctrl+Enter**: turns the line into a task, then cycles its status
  (todo → ongoing → done). Works on several selected lines.
- **Click a status**: menu to pick a status or archive the task.
- **Ctrl+Shift+Enter**: archives the task into the project's archive file.
  For \`work.txt\`, the line moves to \`work_done.txt\` (created when needed), with the date:
  \`- call colleague X - done [2026-11-02]\`
- **Ctrl+Shift+D**: switches between \`work.txt\` and \`work_done.txt\`.
- Command palette → "Task: Archive all completed tasks".

The **Tasks** view (Ctrl+Shift+A) lists the tasks of every note in the open folder,
ongoing ones first. Hover a task to change its status or archive it.

## Activity report

Command palette → "Report: Generate activity report…". KiloNote reads every
\`*_done\` file of the folder and writes a summary by project and by month, ready
to paste into a yearly review. Ongoing tasks are listed too.

## Tabs and tab groups

- Right-click a tab: color, group, close others…
- **Tab groups** have a name and a color; click the label to collapse or expand
  the group. Drag a tab to move it.
- Ctrl+1…9: go to tab number N. Ctrl+Tab: next tab.
- Ctrl+Shift+T: reopen the last closed tab.

## Windows

- **Ctrl+Shift+N**: new window. Each window has its own tabs and folder.
- Right-click a tab → "Move to new window"; right-click a folder → "Open folder in new window".
- Every window comes back the next time you open KiloNote.
- The sidebar and the folder close from the buttons at the top of the sidebar (or Ctrl+B).

## Navigation

- **Ctrl+P**: go to any file of the folder (fuzzy search).
  - \`:42\` goes to line 42, \`@\` lists headings and tasks, \`>\` runs commands.
- **Ctrl+Shift+P**: command palette.
- **Ctrl+Shift+F**: search in all files.
- **Ctrl+F** / **Ctrl+H**: find / replace in the note.
- **Ctrl+D**: select the next occurrence (multiple cursors), **Alt+click**: add a cursor.
- **Alt+↑ / Alt+↓**: move the line. **Ctrl+Shift+K**: delete the line.

## Customization

**Ctrl+,** opens \`settings.json\` (with comments): theme, colors, font, task
statuses and their colors, archive suffix, shortcuts… Save it: everything applies
right away.

- 15 themes (Midnight, Paper, Forest, Ocean, Sand, Retro, Dusk, Slate, Abyss, Neon, Ember,
  Mint, Sakura, Latte, Frost), or automatic. Kilo, the mascot, takes the theme's color.
- Command palette → "Theme: Accent color…" to change the main color.
- Ctrl+= / Ctrl+-: text size. Shift+F11: zen mode. Ctrl+B: sidebar.

## Your notes are safe

- Automatic saving after a short pause (can be turned off).
- Atomic writes: a file is never left half-written.
- Unsaved tabs are kept from one session to the next.
- When another program changes an open note, KiloNote reloads it (or asks you).
- Deleting goes through the system trash.

Happy note-taking! — Kilo
`;
