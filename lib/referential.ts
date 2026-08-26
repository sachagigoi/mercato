/**
 * Référentiel des clubs de Ligue 1.
 *
 * C'est la pièce qui rend le rapprochement article -> piste possible sans
 * ressembler à de la magie : le LLM lit des noms, le code résout des clés. Les
 * noms sont flous et c'est le travail d'un modèle ; les clés sont exactes et
 * c'est le travail d'une table.
 *
 * Les identifiants et les noms viennent du classement Transfermarkt de la
 * saison — **pas d'une liste écrite de mémoire**. La composition change chaque
 * été : Nantes apparaît régulièrement dans les flux mercato sans être en L1.
 * Régénérer avec `npm run referential:l1` après chaque montée/descente.
 *
 * Les alias, eux, sont ajoutés à la main : ce sont les formes de presse
 * (« les Dogues », « OL », « Sang et Or ») qu'aucune source structurée ne donne.
 */

export type Club = {
  /** Identifiant Transfermarkt : la clé qui relie tout le reste. */
  tmId: string;
  name: string;
  /** Formes rencontrées dans la presse, en plus du nom. */
  aliases: readonly string[];
};

export const LIGUE_1: readonly Club[] = [
  { tmId: "244", name: "Olympique de Marseille", aliases: ["OM", "Marseille", "Olympique Marseille", "les Phocéens"] },
  { tmId: "826", name: "RC Lens", aliases: ["Lens", "RCL", "les Sang et Or"] },
  { tmId: "1082", name: "LOSC Lille", aliases: ["LOSC", "Lille", "les Dogues"] },
  { tmId: "1041", name: "Olympique Lyonnais", aliases: ["OL", "Lyon", "Olympique Lyon", "les Gones"] },
  { tmId: "162", name: "AS Monaco", aliases: ["ASM", "Monaco"] },
  // « Paris » tout court est volontairement absent : avec le Paris FC en L1,
  // le raccourci est ambigu, et une piste attribuée au mauvais club est pire
  // qu'une piste manquée. Les gentilés (« les Parisiens », « les Lyonnais »)
  // le sont aussi : ils ne couvrent rien que la ville ne couvre déjà, et
  // attrapent « l'ancien Lyonnais » — le passé d'un joueur, pas un club du deal.
  { tmId: "583", name: "Paris Saint-Germain", aliases: ["PSG", "Paris SG", "Paris Saint Germain"] },
  { tmId: "10004", name: "Paris FC", aliases: ["PFC", "le Paris FC"] },
  { tmId: "273", name: "Stade Rennais", aliases: ["Rennes", "SRFC", "Stade Rennais FC"] },
  { tmId: "3911", name: "Stade Brestois", aliases: ["Brest", "SB29", "Stade Brestois 29"] },
  { tmId: "1164", name: "Le Mans FC", aliases: ["Le Mans", "LMFC"] },
  { tmId: "1158", name: "FC Lorient", aliases: ["Lorient", "FCL", "les Merlus"] },
  { tmId: "417", name: "OGC Nice", aliases: ["Nice", "OGCN", "les Aiglons"] },
  { tmId: "1095", name: "ESTAC Troyes", aliases: ["Troyes", "ESTAC"] },
  { tmId: "738", name: "Le Havre AC", aliases: ["Le Havre", "HAC"] },
  { tmId: "415", name: "Toulouse FC", aliases: ["Toulouse", "TFC", "les Violets"] },
  { tmId: "1420", name: "Angers SCO", aliases: ["Angers", "SCO"] },
  { tmId: "290", name: "AJ Auxerre", aliases: ["Auxerre", "AJA"] },
  { tmId: "667", name: "RC Strasbourg", aliases: ["Strasbourg", "RCSA", "RC Strasbourg Alsace"] },
];

/**
 * Forme de comparaison d'un nom : minuscules, sans accents ni ponctuation.
 * « Saint-Étienne », « saint etienne » et « SAINT ETIENNE » doivent coïncider.
 */
export function normalizeClub(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(le|la|les|l|de|du|des|d)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const INDEX = new Map<string, Club>();
for (const club of LIGUE_1) {
  for (const form of [club.name, ...club.aliases]) {
    const key = normalizeClub(form);
    // Un alias déjà pris n'écrase pas : il devient ambigu, donc inutilisable.
    // Mieux vaut ne pas résoudre que résoudre vers le mauvais club.
    if (INDEX.has(key) && INDEX.get(key)!.tmId !== club.tmId) INDEX.delete(key);
    else INDEX.set(key, club);
  }
}

/** Club de Ligue 1 désigné par ce libellé, ou null. */
export function resolveLigue1Club(raw?: string | null): Club | null {
  if (!raw) return null;
  return INDEX.get(normalizeClub(raw)) ?? null;
}

/** Toutes les formes reconnues, pour le préfiltre. Les plus longues d'abord. */
export const CLUB_FORMS: readonly string[] = [...INDEX.keys()].sort((a, b) => b.length - a.length);

/**
 * Clubs de Ligue 1 **cités** dans un texte.
 *
 * C'est la première porte du pipeline : le périmètre du produit est la L1, et
 * un article sur un transfert Chelsea -> Nottingham n'a rien à faire dans la
 * suite de la chaîne, encore moins dans le budget d'inférence.
 *
 * Attention au sens : une mention n'est pas une partie au transfert. Un article
 * sur Rennes -> Vitinha cite l'OM parce que le joueur en vient. Trancher qui
 * achète et qui vend est le travail de l'extraction, pas du préfiltre.
 */
export function mentionedLigue1Clubs(text: string): Club[] {
  const haystack = ` ${normalizeClub(text)} `;
  const found = new Map<string, Club>();
  for (const form of CLUB_FORMS) {
    if (haystack.includes(` ${form} `)) {
      const club = INDEX.get(form)!;
      found.set(club.tmId, club);
    }
  }
  return [...found.values()];
}
