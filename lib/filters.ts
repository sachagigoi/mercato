import type { Transfer } from "./types.ts";

export type FilterKey = "all" | "official" | "hot" | "extension";

export const DEFAULT_FILTER: FilterKey = "all";

/** Seuil au-delà duquel une rumeur est dite « chaude ». Voir aussi accentOf(). */
export const HOT_THRESHOLD = 70;

export const FILTERS: ReadonlyArray<{
  key: FilterKey;
  label: string;
  empty: string;
  match: (t: Transfer) => boolean;
}> = [
  {
    key: "all",
    label: "Tous",
    empty: "Aucune info pour le moment.",
    match: () => true,
  },
  {
    key: "official",
    label: "Officialisés",
    empty: "Aucun transfert officialisé pour l'instant.",
    match: (t) => t.type === "TRANSFER",
  },
  {
    key: "hot",
    label: "Rumeurs chaudes",
    empty: `Aucune rumeur au-dessus de ${HOT_THRESHOLD} % pour l'instant.`,
    match: (t) => t.type === "RUMOUR" && (t.probability_score ?? 0) >= HOT_THRESHOLD,
  },
  {
    key: "extension",
    label: "Prolongations",
    empty: "Aucune prolongation pour l'instant.",
    match: (t) => t.type === "EXTENSION",
  },
];

export function isFilterKey(value: unknown): value is FilterKey {
  return typeof value === "string" && FILTERS.some((f) => f.key === value);
}

export function filterOf(key: FilterKey) {
  return FILTERS.find((f) => f.key === key) ?? FILTERS[0];
}
