// Built-in themes. Every color goes through CSS variables, so switching
// themes rebuilds nothing: it is instantaneous.

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

/** Kilo's color variants (same as docs/logo-pack): body, body shade, body highlight. */
export const MASCOT_VARIANTS: Record<string, [string, string, string]> = {
  classic: ["#7B6CF6", "#5A4AD6", "#A79CFF"],
  mint: ["#2BB383", "#1E8A64", "#6FD8AE"],
  ocean: ["#3D8BFD", "#2A64C4", "#86B6FF"],
  ember: ["#FF7A3D", "#D6552A", "#FFA67A"],
  sakura: ["#F06292", "#C94775", "#F799B8"],
  retro: ["#FFB000", "#C98600", "#FFD066"],
  slate: ["#6B7A8F", "#4E5A6B", "#9AA6B6"],
  ink: ["#3A3A46", "#26262F", "#5C5C6B"],
};

/** Colors Kilo with a variant, or with the theme's accent ("theme"). */
export function applyMascot(choice: string): void {
  const root = document.documentElement.style;
  const variant = MASCOT_VARIANTS[choice];
  root.setProperty("--kilo-body", variant ? variant[0] : "var(--kn-accent)");
  root.setProperty("--kilo-shade", variant ? variant[1] : "color-mix(in srgb, var(--kn-accent) 72%, #000)");
  root.setProperty("--kilo-light", variant ? variant[2] : "color-mix(in srgb, var(--kn-accent) 55%, #fff)");
}

export const PALETTE_LABELS: Record<string, string> = {
  grey: "Grey", blue: "Blue", cyan: "Cyan", green: "Green", yellow: "Yellow",
  orange: "Orange", red: "Red", pink: "Pink", purple: "Purple",
};

export const THEMES: Theme[] = [
  {
    id: "midnight",
    label: "Midnight — dark",
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
    id: "paper",
    label: "Paper — light",
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
    id: "forest",
    label: "Forest — dark green",
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
    label: "Ocean — deep blue",
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
    id: "sand",
    label: "Sand — warm light",
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
    label: "Retro — amber terminal",
    dark: true,
    colors: {
      bg: "#14110c", bg_alt: "#100d09", bg_hover: "#211b12", border: "#2a2216",
      fg: "#ffc56b", fg_muted: "#c4964f", fg_faint: "#7a5e33", accent: "#ffb000",
      selection: "#ffb00030", cursor: "#ffcf66", line: "#ffb0000c",
      red: "#ff6f4d", orange: "#ff9a3c", yellow: "#ffd866", green: "#c8e06a", cyan: "#ffd59a",
      blue: "#f2c27a", purple: "#e8a87c", pink: "#ff9f80", grey: "#a08350",
    },
  },
  {
    id: "dusk",
    label: "Dusk — twilight purple",
    dark: true,
    colors: {
      bg: "#1e1a2b", bg_alt: "#181524", bg_hover: "#2a2440", border: "#2f2846",
      fg: "#e4dff2", fg_muted: "#a59cbf", fg_faint: "#6a6185", accent: "#f28fb8",
      selection: "#f28fb833", cursor: "#f6a8c8", line: "#ffffff08",
      red: "#ff7a93", orange: "#ffab6e", yellow: "#f1d38a", green: "#9ddca0", cyan: "#84d8e6",
      blue: "#8fb0ff", purple: "#c6a2ff", pink: "#f28fb8", grey: "#948bab",
    },
  },
  {
    id: "slate",
    label: "Slate — neutral grey",
    dark: true,
    colors: {
      bg: "#202225", bg_alt: "#1a1c1e", bg_hover: "#2b2e32", border: "#303338",
      fg: "#d9dce1", fg_muted: "#9aa0a8", fg_faint: "#62676f", accent: "#6fa8dc",
      selection: "#6fa8dc30", cursor: "#8bbbe6", line: "#ffffff07",
      red: "#e5787a", orange: "#e3a46f", yellow: "#dcc57d", green: "#9fc98f", cyan: "#7fc6c9",
      blue: "#7fa9e0", purple: "#b39ddb", pink: "#e597b6", grey: "#8c9198",
    },
  },
  {
    id: "abyss",
    label: "Abyss — pure black",
    dark: true,
    colors: {
      bg: "#000000", bg_alt: "#0a0a0c", bg_hover: "#17171c", border: "#1f1f26",
      fg: "#f2f2f5", fg_muted: "#a3a3ad", fg_faint: "#5c5c66", accent: "#7c9cff",
      selection: "#7c9cff38", cursor: "#9fb6ff", line: "#ffffff0a",
      red: "#ff6b7f", orange: "#ffa04d", yellow: "#ffd75e", green: "#6ee08a", cyan: "#4fd8ee",
      blue: "#7c9cff", purple: "#c38bff", pink: "#ff7ac0", grey: "#8e8e99",
    },
  },
  {
    id: "neon",
    label: "Neon — synth night",
    dark: true,
    colors: {
      bg: "#170f26", bg_alt: "#120b1e", bg_hover: "#231738", border: "#2c1c45",
      fg: "#ece2ff", fg_muted: "#a996cc", fg_faint: "#6b5a8c", accent: "#ff4fd8",
      selection: "#ff4fd833", cursor: "#3ef0ff", line: "#ff4fd80c",
      red: "#ff5c8a", orange: "#ff9d4d", yellow: "#ffe45e", green: "#4dffb0", cyan: "#3ef0ff",
      blue: "#6c8cff", purple: "#b26bff", pink: "#ff4fd8", grey: "#8f80b0",
    },
  },
  {
    id: "ember",
    label: "Ember — warm coal",
    dark: true,
    colors: {
      bg: "#1f1a17", bg_alt: "#191512", bg_hover: "#2b241f", border: "#332a24",
      fg: "#ece0d4", fg_muted: "#b09d8b", fg_faint: "#76665a", accent: "#ff8a4c",
      selection: "#ff8a4c30", cursor: "#ffa36f", line: "#ffffff07",
      red: "#f2705f", orange: "#ff8a4c", yellow: "#f2c063", green: "#b5c97a", cyan: "#8cc7b8",
      blue: "#8fa8d6", purple: "#c79bc9", pink: "#f08fa6", grey: "#9c8b7e",
    },
  },
  {
    id: "mint",
    label: "Mint — fresh light",
    dark: false,
    colors: {
      bg: "#f6fbf8", bg_alt: "#eaf4ee", bg_hover: "#dcece3", border: "#d3e5da",
      fg: "#22322b", fg_muted: "#5b7166", fg_faint: "#9db1a6", accent: "#0e8763",
      selection: "#0e876326", cursor: "#0e8763", line: "#0000000a",
      red: "#d23f4f", orange: "#c96a1b", yellow: "#9a7a0a", green: "#2e8a3e", cyan: "#0f8a92",
      blue: "#2f6fc2", purple: "#7a52c4", pink: "#c43d84", grey: "#6f8178",
    },
  },
  {
    id: "sakura",
    label: "Sakura — soft pink",
    dark: false,
    colors: {
      bg: "#fdf7f8", bg_alt: "#f8ecef", bg_hover: "#f1dde2", border: "#ecd5db",
      fg: "#3a2a30", fg_muted: "#7d6670", fg_faint: "#b9a3ac", accent: "#d6457b",
      selection: "#d6457b24", cursor: "#d6457b", line: "#0000000a",
      red: "#c93a4b", orange: "#c4621c", yellow: "#9a780c", green: "#3d8a4a", cyan: "#1a8590",
      blue: "#3c66c0", purple: "#8b4fc0", pink: "#d6457b", grey: "#85737b",
    },
  },
  {
    id: "latte",
    label: "Latte — cream and coffee",
    dark: false,
    colors: {
      bg: "#faf6ef", bg_alt: "#f2ebdf", bg_hover: "#e9dfcf", border: "#e3d8c5",
      fg: "#3b2f25", fg_muted: "#7c6a5a", fg_faint: "#b3a28f", accent: "#8a5a35",
      selection: "#8a5a3526", cursor: "#8a5a35", line: "#0000000a",
      red: "#b8423a", orange: "#b4621f", yellow: "#8f7413", green: "#557d33", cyan: "#2d7d7a",
      blue: "#3c63a3", purple: "#7d4f93", pink: "#b04877", grey: "#847565",
    },
  },
  {
    id: "frost",
    label: "Frost — cool light",
    dark: false,
    colors: {
      bg: "#f5f8fc", bg_alt: "#e9eff7", bg_hover: "#dce5f1", border: "#d5dfec",
      fg: "#1f2a3a", fg_muted: "#5a6a80", fg_faint: "#9aa8ba", accent: "#3f6fd8",
      selection: "#3f6fd826", cursor: "#3f6fd8", line: "#0000000a",
      red: "#cc3d4d", orange: "#c4641c", yellow: "#93760c", green: "#2f8545", cyan: "#0c8394",
      blue: "#3f6fd8", purple: "#7b55c9", pink: "#c23f86", grey: "#6e7b8c",
    },
  },
];

/** Former (French) theme ids, still accepted in settings.json. */
const LEGACY_IDS: Record<string, string> = { minuit: "midnight", papier: "paper", foret: "forest", sable: "sand" };

export function findTheme(id: string, systemDark: boolean): Theme {
  if (id === "auto") return THEMES.find((t) => t.id === (systemDark ? "midnight" : "paper"))!;
  const wanted = LEGACY_IDS[id] ?? id;
  return THEMES.find((t) => t.id === wanted) ?? THEMES[0];
}

/** Resolves a palette color name ("blue"), or returns the value as is ("#ff0"). */
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
