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
