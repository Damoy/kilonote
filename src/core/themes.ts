// Thèmes intégrés. Toutes les couleurs passent par des variables CSS :
// changer de thème ne recrée rien, c'est instantané.

export type ColorKey =
  | "bg" | "bg_alt" | "bg_hover" | "border" | "fg" | "fg_muted" | "fg_faint" | "accent"
  | "selection" | "cursor" | "line"
  | "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink" | "grey";

export interface Theme {
  id: string;
  label: string;
  dark: boolean;
  colors: Record<ColorKey, string>;
}

export const PALETTE_NAMES = ["grey", "blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple"] as const;

export const PALETTE_LABELS: Record<string, string> = {
  grey: "Gris", blue: "Bleu", cyan: "Cyan", green: "Vert", yellow: "Jaune",
  orange: "Orange", red: "Rouge", pink: "Rose", purple: "Violet",
};

export const THEMES: Theme[] = [
  {
    id: "minuit",
    label: "Minuit — sombre",
    dark: true,
    colors: {
      bg: "#1b1c22", bg_alt: "#16171c", bg_hover: "#26272f", border: "#2a2b34",
      fg: "#d7d9e2", fg_muted: "#9a9caa", fg_faint: "#5f6170", accent: "#9284f7",
      selection: "#9284f733", cursor: "#a99ef9", line: "#ffffff08",
      red: "#f2788f", orange: "#f5a26f", yellow: "#e8c47c", green: "#a3d68c", cyan: "#79d0e8",
      blue: "#7ea8f8", purple: "#c29ef5", pink: "#f592b8", grey: "#8b8fa3",
    },
  },
  {
    id: "papier",
    label: "Papier — clair",
    dark: false,
    colors: {
      bg: "#fbfaf7", bg_alt: "#f1efe9", bg_hover: "#e8e5dd", border: "#e2ded4",
      fg: "#2c2b33", fg_muted: "#6d6b77", fg_faint: "#a9a6b0", accent: "#6a5ae0",
      selection: "#6a5ae026", cursor: "#6a5ae0", line: "#0000000a",
      red: "#d43c5c", orange: "#c8661c", yellow: "#a87c0c", green: "#3f8f3a", cyan: "#0e8aa6",
      blue: "#3767d1", purple: "#8b4fd1", pink: "#cc3d86", grey: "#7b7d8c",
    },
  },
  {
    id: "foret",
    label: "Forêt — sombre vert",
    dark: true,
    colors: {
      bg: "#1a201d", bg_alt: "#151a17", bg_hover: "#232b27", border: "#28302c",
      fg: "#d5dfd8", fg_muted: "#93a29a", fg_faint: "#5c6a63", accent: "#7fd3a0",
      selection: "#7fd3a02e", cursor: "#9fe3b8", line: "#ffffff07",
      red: "#ee8277", orange: "#e9a56a", yellow: "#dcc77a", green: "#98d982", cyan: "#7ccfc4",
      blue: "#86aee8", purple: "#c0a2e6", pink: "#e99ab8", grey: "#8a978f",
    },
  },
  {
    id: "ocean",
    label: "Océan — bleu nuit",
    dark: true,
    colors: {
      bg: "#111a24", bg_alt: "#0d151d", bg_hover: "#1a2632", border: "#1f2c39",
      fg: "#d3deea", fg_muted: "#8ea1b5", fg_faint: "#556779", accent: "#4fc1ff",
      selection: "#4fc1ff2b", cursor: "#7fd3ff", line: "#ffffff07",
      red: "#ff7b8a", orange: "#ffad66", yellow: "#f1d27a", green: "#8fdc94", cyan: "#5fe0d8",
      blue: "#6cb6ff", purple: "#b9a2ff", pink: "#ff94c8", grey: "#8394a7",
    },
  },
  {
    id: "sable",
    label: "Sable — clair chaud",
    dark: false,
    colors: {
      bg: "#f7f1e5", bg_alt: "#efe6d4", bg_hover: "#e6dbc5", border: "#e0d4bd",
      fg: "#3a3128", fg_muted: "#7a6c5c", fg_faint: "#b2a48f", accent: "#c4511a",
      selection: "#c4511a24", cursor: "#c4511a", line: "#0000000a",
      red: "#c2363f", orange: "#c4511a", yellow: "#9a7208", green: "#4f7f2a", cyan: "#21808a",
      blue: "#2f62a8", purple: "#80479e", pink: "#b8406f", grey: "#857868",
    },
  },
  {
    id: "retro",
    label: "Rétro — terminal ambre",
    dark: true,
    colors: {
      bg: "#14110c", bg_alt: "#100d09", bg_hover: "#211b12", border: "#2a2216",
      fg: "#ffc56b", fg_muted: "#c4964f", fg_faint: "#7a5e33", accent: "#ffb000",
      selection: "#ffb00030", cursor: "#ffcf66", line: "#ffb0000c",
      red: "#ff6f4d", orange: "#ff9a3c", yellow: "#ffd866", green: "#c8e06a", cyan: "#ffd59a",
      blue: "#f2c27a", purple: "#e8a87c", pink: "#ff9f80", grey: "#a08350",
    },
  },
];

export function findTheme(id: string, systemDark: boolean): Theme {
  if (id === "auto") return THEMES.find((t) => t.id === (systemDark ? "minuit" : "papier"))!;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Résout un nom de couleur de palette (« blue ») ou renvoie la valeur telle quelle (« #ff0 »). */
export function resolveColor(value: string | undefined | null): string {
  if (!value) return "var(--kn-grey)";
  return (PALETTE_NAMES as readonly string[]).includes(value) || value === "accent" ? `var(--kn-${value})` : value;
}

export function applyTheme(theme: Theme, accent: string | null, overrides: Record<string, string>): void {
  const root = document.documentElement;
  const colors: Record<string, string> = { ...theme.colors };
  if (accent) {
    colors.accent = accent;
    colors.cursor = accent;
    colors.selection = `color-mix(in srgb, ${accent} 22%, transparent)`;
  }
  for (const [k, v] of Object.entries(overrides ?? {})) if (typeof v === "string") colors[k] = v;
  for (const [k, v] of Object.entries(colors)) root.style.setProperty(`--kn-${k.replace(/_/g, "-")}`, v);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors.bg_alt);
}
