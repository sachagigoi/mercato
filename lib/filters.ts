import { countryKey } from "./countries.ts";
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

// --- Second axe : le pays du club acheteur ---------------------------------
//
// Le filtre de type répond à « quelle sorte d'info », celui-ci à « quel
// marché ». Les deux se composent, et c'est le but : un feed mondial de rumeurs
// noie l'information qu'on cherche, et le pays est la coupe la plus naturelle
// pour un lecteur — on suit un championnat avant de suivre une catégorie.
//
// C'est bien le pays du club ACHETEUR, pas la nationalité du joueur : ce qu'on
// veut savoir, c'est où la rumeur pourrait aboutir.

export const ALL_COUNTRIES = "all";

export type CountryOption = {
  /** Clé d'URL et d'égalité. `ALL_COUNTRIES` pour la puce « Tous les pays ». */
  key: string;
  label: string;
  /** Code drapeau, ou null pour un pays hors table de correspondance. */
  code: string | null;
  count: number;
};

/** Clé de pays d'une ligne, ou null quand la source ne la situe pas. */
export function countryKeyOf(t: Transfer): string | null {
  return countryKey(t.to_country_code, t.to_country_name);
}

export function matchesCountry(t: Transfer, key: string): boolean {
  return key === ALL_COUNTRIES || countryKeyOf(t) === key;
}

/**
 * Puces de pays, les plus fournies d'abord.
 *
 * Deux jeux, et c'est le point délicat de la composition des deux axes :
 * `present` décide QUELLES puces existent, `counted` décide de leurs COMPTES.
 * En pratique, la liste vient du feed entier et les nombres du type
 * sélectionné.
 *
 * Les dériver tous deux du type sélectionné semblait plus simple, et se
 * comportait mal : la puce active disparaissait dès qu'on changeait de type,
 * emportant la sélection et le nom du pays avec elle. Une rangée de filtres qui
 * se réorganise sous le doigt de qui l'utilise n'est pas un filtre.
 *
 * La liste reste dérivée des lignes et non d'une nomenclature figée : afficher
 * « Portugal » parce que le Portugal existe donnerait une puce qui ne mène
 * nulle part, alors qu'un championnat exotique présent dans le feed doit
 * pouvoir être filtré comme les autres.
 *
 * Les lignes non situées — le seed, et toute source qui ne donnerait pas de
 * championnat — ne créent pas de puce. Elles restent visibles sous « Tous les
 * pays », ce qui est exactement ce que la puce annonce.
 */
export function countryOptions(
  present: readonly Transfer[],
  counted: readonly Transfer[] = present,
): CountryOption[] {
  const byKey = new Map<string, CountryOption>();

  for (const row of present) {
    const key = countryKeyOf(row);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      key,
      label: row.to_country_name ?? key,
      code: row.to_country_code,
      count: 0,
    });
  }

  for (const row of counted) {
    const key = countryKeyOf(row);
    const option = key ? byKey.get(key) : undefined;
    if (option) option.count += 1;
  }

  const sorted = [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, "fr"),
  );

  return [
    { key: ALL_COUNTRIES, label: "Tous les pays", code: null, count: counted.length },
    ...sorted,
  ];
}
