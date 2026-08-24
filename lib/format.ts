/** Code ISO 3166-1 alpha-2 -> emoji drapeau, par arithmétique regional-indicator. */
export function flagEmoji(iso?: string | null): string {
  if (!iso || iso.length !== 2) return "";
  const cps = [...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  if (cps.some((c) => c < 0x1f1e6 || c > 0x1f1ff)) return "";
  return String.fromCodePoint(...cps);
}

/**
 * Initiales d'un club pour le fallback d'écusson.
 *
 * Les noms de clubs contiennent souvent un acronyme déjà constitué (PSV, AS,
 * FC, OGC). Le réduire à sa première lettre donne des résultats absurdes —
 * « PSV Eindhoven » deviendrait « PE ». On le garde entier et on complète avec
 * les initiales des mots suivants.
 */
export function clubInitials(name?: string | null): string {
  if (!name) return "?";

  const words = name.split(/[\s-]+/).filter((w) => w.length > 1);
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();

  const isAcronym = (w: string) => w.length <= 3 && w === w.toUpperCase();
  const head = isAcronym(words[0]) ? words[0] : words[0][0];
  const tail = words.slice(1).map((w) => w[0]).join("");

  return (head + tail).slice(0, 3).toUpperCase();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Temps relatif en français, court.
 * Rendu dans un <time suppressHydrationWarning> : serveur et client ne
 * s'exécutent pas à la même seconde, et un écart de libellé ne doit pas
 * faire échouer l'hydratation.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  if (diff < MINUTE) return "à l'instant";
  if (diff < HOUR) return `il y a ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `il y a ${Math.floor(diff / HOUR)} h`;
  const days = Math.floor(diff / DAY);
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} j`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** Variation de probabilité, affichée seulement si elle est lisible (>= 3 pts). */
export function probabilityTrend(
  current: number | null,
  previous: number | null,
): { delta: number; direction: "up" | "down" } | null {
  if (current == null || previous == null) return null;
  const delta = current - previous;
  if (Math.abs(delta) < 3) return null;
  return { delta, direction: delta > 0 ? "up" : "down" };
}

/**
 * Clé de cache d'un nom : minuscules, sans accents ni ponctuation.
 * « Atlético Madrid » et « Atletico  Madrid! » doivent toucher la même entrée.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // marques diacritiques combinantes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type ParsedFee = {
  /** Libellé affiché sur la carte, déjà francisé. */
  transfer_fee: string;
  /** Valeur en euros, ou null quand le montant n'est pas chiffrable (prêt sec, inconnu). */
  fee_value_eur: number | null;
};

const LOAN = /\b(loan|leihe|pr[eê]t)\b/i;
const FREE = /\b(free|abl[oö]sefrei|libre|bosman)\b/i;
const UNKNOWN = /^[\s?\-–—.]*$/;

/** Montant chiffré : « €45.00m », « 850k », « 1.2 bn », « 45 M€ ». */
const AMOUNT = /(\d+(?:[.,]\d+)?)\s*(bn|mrd|m|k|th)?\b/i;

const SCALE: Record<string, number> = {
  bn: 1_000_000_000,
  mrd: 1_000_000_000,
  m: 1_000_000,
  k: 1_000,
  th: 1_000,
};

/** Formate un montant en euros pour l'affichage, en notation française. */
export function formatFee(euros: number): string {
  if (euros === 0) return "Libre";
  if (euros >= 1_000_000_000) {
    const bn = euros / 1_000_000_000;
    const shown = Number.isInteger(bn) ? String(bn) : bn.toFixed(1).replace(".", ",");
    return `${shown} Md€`;
  }
  if (euros >= 1_000_000) {
    const m = euros / 1_000_000;
    // 45 M€ plutôt que 45,0 M€ ; 1,5 M€ plutôt que 1,5000000000000002 M€
    const shown = Number.isInteger(m) ? String(m) : m.toFixed(1).replace(".", ",");
    return `${shown} M€`;
  }
  if (euros >= 1_000) {
    const k = euros / 1_000;
    const shown = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(".", ",");
    return `${shown} k€`;
  }
  return `${euros} €`;
}

/**
 * Normalise un montant brut de source en couple (libellé, valeur).
 *
 * Le libellé est francisé ici, une fois, à l'ingestion — jamais au rendu : la
 * carte doit pouvoir afficher `transfer_fee` tel quel. La valeur numérique
 * existe en parallèle parce qu'on ne trie ni ne filtre sur du texte.
 *
 * L'ordre des tests compte : « loan fee: €2.00m » est d'abord un prêt.
 */
export function parseFee(raw?: string | null): ParsedFee {
  const value = (raw ?? "").trim();
  if (UNKNOWN.test(value)) return { transfer_fee: "—", fee_value_eur: null };

  if (LOAN.test(value)) return { transfer_fee: "Prêt", fee_value_eur: null };
  if (FREE.test(value)) return { transfer_fee: "Libre", fee_value_eur: 0 };

  const match = AMOUNT.exec(value);
  if (!match) return { transfer_fee: "—", fee_value_eur: null };

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return { transfer_fee: "—", fee_value_eur: null };

  const euros = Math.round(amount * (SCALE[match[2]?.toLowerCase() ?? ""] ?? 1));
  return { transfer_fee: formatFee(euros), fee_value_eur: euros };
}
