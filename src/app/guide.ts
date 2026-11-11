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

**Due dates**: write \`@2026-11-14\` in a task, or press **Ctrl+Shift+U** and pick
today, tomorrow, next Monday… (or type \`14/11\`, \`+3\`, \`2w\`). Overdue tasks turn red.

- send the monthly report @2026-11-30 - todo

The **Tasks** view (Ctrl+Shift+A) lists the tasks of every note in the open folder,
ongoing ones first. Filter them (*Open*, *Ongoing*, *Due*, or a \`#tag\`), and hover a
task to change its status or archive it. The badge counts overdue tasks.

The **task board** (**Ctrl+Alt+K**, or the board button of the Tasks view) shows the
same tasks in one column per status. Drag a card to another column: its status
changes in its note (the notes stay the only place where tasks live). Click a card
to open its note on that line, right-click it for every status or to archive it, or
focus it and press ←/→. The filter keeps the cards with some words, a \`#tag\` or a
note name.

## Activity report

Command palette → "Report: Generate activity report…", then a period (this or last
week, month or year, the last 12 months, all time). KiloNote reads every \`*_done\`
file of the folder and writes a summary by project and by month, ready to paste into
a review. Ongoing tasks are listed too. "Report: Generate activity report for a #tag…" limits
it to the tasks of one tag (a client, a topic…).

## Tabs and tab groups

- Right-click a tab: color, group, close others…
- **Tab groups** have a name and a color; click the label to collapse the group into
  a compact stack (only the tab you are editing stays visible), click again to expand
  it. Command palette → "Tab: Collapse all groups". Drag a tab to move it.
- Ctrl+1…9: go to tab number N. Ctrl+Tab: next tab.
- Ctrl+Shift+T: reopen the last closed tab.
- When the tabs no longer fit, the list button at the right shows them all.

## Windows

- **Ctrl+Shift+N**: new window. Each window has its own tabs and folder.
- Drag a tab onto another KiloNote window to move it there, or out of the window to
  open it in a new one (also: right-click a tab → "Move to new window").
- Right-click a folder → "Open folder in new window".
- Every window comes back the next time you open KiloNote.
- The sidebar and the folder close from the buttons at the top of the sidebar (or Ctrl+B).

## Navigation

- **Ctrl+P**: go to any file of the folder (fuzzy search).
  - \`:42\` goes to line 42, \`@\` lists headings and tasks, \`>\` runs commands.
- **Ctrl+Shift+P**: command palette.
- **Ctrl+Shift+F**: search in all files; the ⇄ button adds a replace field (with undo).
- **Ctrl+Shift+V** (or the *Preview* / *Tree* button at the right of the tabs): a second
  view next to the editor. Markdown, HTML and SVG files get a preview (pages run no
  script and load nothing from the network); JSON and YAML files get a tree: hover a
  node to see it in the text, double-click a value or a key to change it. Drag the
  separator to make the pane wider; its corner button shows it alone.
- XML files get a tree too; Mermaid files (\`.mmd\`) and \`\`\`mermaid blocks of a
  Markdown note are drawn as diagrams; a SQL file shows its schema, tables, data
  and statements.
- In an HTML preview, the pencil button lets you change the text of the page in
  place: the HTML follows.
- **Ctrl+F** / **Ctrl+H**: find / replace in the note. The count of matches in the
  whole note shows next to the field ("3 of 12"), and marks along the scrollbar show
  where they are.
- Select some text: the status bar tells how many times it appears in the note (or
  "only here"), the other occurrences are highlighted and marked along the scrollbar.
  Click the count, or **Ctrl+F3** / **Ctrl+Shift+F3**, to go to the next / previous one.
- Along the scrollbar, small marks show where the headings and the open tasks of the
  note are (in the color of their status), and the matches of a search.
- **Ctrl+D**: select the next occurrence (multiple cursors), **Alt+click**: add a cursor.
- Click a line number to select the whole line, without its line break (drag for
  several lines, Shift+click to extend): then **Ctrl+C** / **Ctrl+X** copies or cuts its
  text, **Shift+Alt+↓** duplicates it, **Ctrl+Shift+K** deletes it.
- **Ctrl+↑ / Ctrl+↓**: the cursor moves one line and the text scrolls with it, so the
  line stays where it is on the screen.
- **Alt+↑ / Alt+↓**: move the line. **Ctrl+Shift+K**: delete the line.
- **Shift+Alt+F**: format the document or the selection (JSON, XML, HTML, CSS, SQL,
  Markdown tables). Command palette → "Edit: Minify JSON".
- The explorer button with two arrows collapses every folder (or expands them all).
  Hover a folder for its own button: everything inside it. Alt+click does the same.
- **Ctrl+?**: the shortcuts cheat sheet (also the keyboard button of the status bar).

## Images in notes

Paste an image (a screenshot, an image copied from a page…) with **Ctrl+V** in a
\`.txt\` or \`.md\` note: it is saved next to the note, in an \`images\` folder, and a
line such as \`![image](images/work-2026-11-09-153012.png)\` is written where the
cursor is. The image shows right under that line; click it to see it full size.
The note stays a plain text file: any other editor shows the line, and the image is
an ordinary file next to it. The folder and the display can be changed in the
settings (Editor).

Image files can also be dropped on a note (from the file explorer): they are copied
into the images folder under their own name, or just referenced if they already are
in the note's folder. Command palette → "File: Delete unused images…" moves the
images that no note shows any more to the system trash, after listing them.

## Secrets

Select a private piece of a note (an access, a password…), then command palette →
"Edit: Encrypt selection with a password". It becomes an encrypted block in the note,
shown as a **Secret** box: click it and type the password to see the text, copy it,
change it, or put it back in clear. The password is never saved (tick the box to keep
it in memory for 10 minutes); a forgotten password cannot be recovered.

## Links between notes

Write \`[[work]]\` (the name of another note of the folder, its extension optional) or
\`[[projects/report]]\` to link to a note. Typing \`[[\` offers the notes of the folder.
**Ctrl+click** on a link opens the note; if it does not exist yet, KiloNote offers to
create it next to the current one. **Ctrl+Alt+B** lists the notes that link to the
current one. \`[[work|the work note]]\` shows a label too.

## Templates

**Ctrl+Alt+N** makes a new note from a template: daily note, meeting notes, project,
Markdown page, or one of yours. **Ctrl+Alt+D** opens today's note, \`daily/2026-11-11.txt\`
in the open folder, made from the "Daily note" template the first time.
In a template, \`{{date}}\`, \`{{time}}\`, \`{{weekday}}\`, \`{{title}}\` and \`{{cursor}}\`
(where the cursor goes) are filled in. Command palette → "Template: Edit templates…"
changes a template or makes a new one (they are files of the settings folder).

## Code and config files

Python, JavaScript, TypeScript, C#, Java, C/C++, Go, Rust, SQL, PowerShell, Batch,
Shell, YAML, TOML, INI, XML, HTML, CSS and more are colored. Click the document
type in the status bar to change it. Task, tag and mention highlighting stays off
in those files.

## Customization

**Ctrl+,** opens the settings: theme, colors, fonts, editor, files, task statuses
and their colors, archive options, shortcuts. Every change applies right away. All of
it lives in \`settings.json\` (with comments), one click away from the settings screen.

- 15 themes (Midnight, Paper, Forest, Ocean, Sand, Retro, Dusk, Slate, Abyss, Neon, Ember,
  Mint, Sakura, Latte, Frost), or automatic. Kilo, the mascot, takes the theme's color.
- Command palette → "Theme: Accent color…" to change the main color.
- Four icon packs (Settings → Appearance): Line, Bold, Duotone and Pixel.
- Ctrl+= / Ctrl+-: text size. Shift+F11: zen mode. Ctrl+B: sidebar.

## Your notes are safe

- Automatic saving after a short pause (can be turned off).
- Atomic writes: a file is never left half-written.
- Unsaved tabs are kept from one session to the next.
- When another program changes an open note, KiloNote reloads it (or asks you).
- Local history: before a version is thrown away (overwrite, reload, replace in files),
  a copy is kept. Command palette → "File: Local history".
- Each file keeps its encoding and line endings.
- Deleting goes through the system trash.

Happy note-taking! — Kilo
`;
