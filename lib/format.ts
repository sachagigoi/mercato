/**
 * Code pays -> emoji drapeau.
 *
 * Deux formes, parce que le football ne se joue pas en pays ISO : « fr » passe
 * par l'arithmétique regional-indicator classique, tandis que les nations
 * britanniques — « gb-eng », « gb-sct », « gb-wls » — n'ont pas de code
 * ISO 3166-1 et demandent une séquence de balises sur le drapeau noir.
 * Sans ce second cas, la Premier League s'afficherait sous l'Union Jack, ou
 * sans drapeau du tout.
 */
export function flagEmoji(code?: string | null): string {
  if (!code) return "";
  const value = code.toLowerCase();

  const subdivision = /^([a-z]{2})-([a-z]{3})$/.exec(value);
  if (subdivision) {
    const tags = [...subdivision[1], ...subdivision[2]].map((c) => 0xe0000 + c.charCodeAt(0));
    return String.fromCodePoint(0x1f3f4, ...tags, 0xe007f);
  }

  if (value.length !== 2) return "";
  const cps = [...value.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
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

  const euros = amountToEuros(value);
  if (euros === null) return { transfer_fee: "—", fee_value_eur: null };

  return { transfer_fee: formatFee(euros), fee_value_eur: euros };
}

/**
 * Montant brut -> euros, sans interprétation.
 *
 * Extrait de `parseFee` pour servir aussi aux valeurs de marché, qui suivent la
 * même grammaire (« €220.00m », « €800k ») mais pas la même sémantique : un
 * prêt ou un transfert libre n'ont aucun sens pour une estimation, et les
 * chercher ici ferait lire « Libre » sur un joueur qui vaut zéro.
 */
export function amountToEuros(raw: string): number | null {
  const match = AMOUNT.exec(raw);
  if (!match) return null;

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;

  return Math.round(amount * (SCALE[match[2]?.toLowerCase() ?? ""] ?? 1));
}

export type ParsedMarketValue = {
  /** Valeur estimée en euros. Jamais nulle ni négative — voir `parseMarketValue`. */
  market_value_eur: number;
  /** Libellé francisé à l'ingestion, affiché tel quel : « 220 M€ ». */
  market_value_label: string;
};

/**
 * Valeur de marché d'une fiche joueur.
 *
 * Renvoie `null` plutôt qu'un zéro quand la source n'estime pas le joueur :
 * Transfermarkt écrit alors « - », et `formatFee(0)` rendrait « Libre », ce qui
 * annoncerait un joueur en fin de contrat là où on ne sait simplement rien.
 * La carte préfère ne rien afficher qu'afficher faux.
 */
export function parseMarketValue(raw?: string | null): ParsedMarketValue | null {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return null;

  const euros = amountToEuros(value);
  if (euros === null || euros <= 0) return null;

  return { market_value_eur: euros, market_value_label: formatFee(euros) };
}
