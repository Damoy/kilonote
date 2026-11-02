// Recherche floue façon Sublime Text : les lettres doivent apparaître dans
// l'ordre ; bonus pour les lettres consécutives, les débuts de mots et le nom
// de fichier.

export interface FuzzyResult {
  score: number;
  positions: number[];
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1];
  return /[\s/\\_\-.:()[\]]/.test(prev) || (prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase());
};

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (!query) return { score: 0, positions: [] };
  const q = fold(query).replace(/\s+/g, "");
  const t = fold(text);
  if (!q) return { score: 0, positions: [] };

  // Correspondance exacte d'une sous-chaîne : très bon score.
  const direct = t.indexOf(q);
  const positions: number[] = [];
  let score = 0;
  if (direct >= 0) {
    for (let i = 0; i < q.length; i++) positions.push(direct + i);
    score = 1000 - direct + (isBoundary(text, direct) ? 200 : 0) + q.length * 10;
  } else {
    let ti = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      // Préférer un début de mot s'il y en a un plus loin pour cette lettre.
      let found = -1;
      for (let j = ti; j < t.length; j++) {
        if (t[j] !== q[qi]) continue;
        if (found < 0) found = j;
        if (j === prev + 1 || isBoundary(text, j)) {
          found = j;
          break;
        }
      }
      if (found < 0) return null;
      score += found === prev + 1 ? 15 : 0;
      score += isBoundary(text, found) ? 10 : 0;
      score -= Math.min(found - ti, 10);
      positions.push(found);
      prev = found;
      ti = found + 1;
    }
  }
  // Bonus si la correspondance tombe dans le nom de fichier (après le dernier séparateur).
  const lastSep = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (positions.length && positions[0] > lastSep) score += 60;
  score -= text.length * 0.2;
  return { score, positions };
}

export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string, limit = 200): { item: T; result: FuzzyResult }[] {
  const out: { item: T; result: FuzzyResult }[] = [];
  for (const item of items) {
    const result = fuzzyMatch(query, key(item));
    if (result) out.push({ item, result });
  }
  if (query) out.sort((a, b) => b.result.score - a.result.score);
  return out.slice(0, limit);
}
