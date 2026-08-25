/**
 * Pays d'un championnat : du libellé de la source au couple (code, nom français).
 *
 * La page des rumeurs sert la locale anglaise (§ scraper), donc « Poland » et
 * non « Pologne ». La résolution se fait ici, à l'ingestion, une fois pour
 * toutes — même règle que `parseFee` : la carte affiche `to_country_name` tel
 * quel, sans table de correspondance embarquée dans le bundle client.
 *
 * Le code sert au drapeau et à la clé de filtre ; le nom sert à l'affichage.
 * Les deux sont séparés parce qu'ils ne dégradent pas ensemble : un pays absent
 * de cette table garde son nom et perd seulement son drapeau, ce qui laisse la
 * puce de filtre lisible au lieu de la faire disparaître.
 */

/** Nom source (minuscules) -> code de drapeau + nom français. */
const COUNTRIES: Record<string, { code: string | null; name: string }> = {
  // Les nations britanniques ne sont pas des pays ISO 3166-1 : leur drapeau
  // passe par un code de subdivision, que `flagEmoji` sait rendre. C'est ce qui
  // permet à la Premier League d'afficher le drapeau anglais et non l'Union Jack.
  england: { code: "gb-eng", name: "Angleterre" },
  scotland: { code: "gb-sct", name: "Écosse" },
  wales: { code: "gb-wls", name: "Pays de Galles" },
  "northern ireland": { code: null, name: "Irlande du Nord" },

  spain: { code: "es", name: "Espagne" },
  italy: { code: "it", name: "Italie" },
  germany: { code: "de", name: "Allemagne" },
  france: { code: "fr", name: "France" },
  portugal: { code: "pt", name: "Portugal" },
  netherlands: { code: "nl", name: "Pays-Bas" },
  belgium: { code: "be", name: "Belgique" },
  ireland: { code: "ie", name: "Irlande" },
  austria: { code: "at", name: "Autriche" },
  switzerland: { code: "ch", name: "Suisse" },
  greece: { code: "gr", name: "Grèce" },
  turkey: { code: "tr", name: "Turquie" },
  türkiye: { code: "tr", name: "Turquie" },
  denmark: { code: "dk", name: "Danemark" },
  sweden: { code: "se", name: "Suède" },
  norway: { code: "no", name: "Norvège" },
  finland: { code: "fi", name: "Finlande" },
  iceland: { code: "is", name: "Islande" },
  poland: { code: "pl", name: "Pologne" },
  "czech republic": { code: "cz", name: "Tchéquie" },
  czechia: { code: "cz", name: "Tchéquie" },
  slovakia: { code: "sk", name: "Slovaquie" },
  hungary: { code: "hu", name: "Hongrie" },
  romania: { code: "ro", name: "Roumanie" },
  bulgaria: { code: "bg", name: "Bulgarie" },
  croatia: { code: "hr", name: "Croatie" },
  serbia: { code: "rs", name: "Serbie" },
  slovenia: { code: "si", name: "Slovénie" },
  "bosnia-herzegovina": { code: "ba", name: "Bosnie-Herzégovine" },
  "bosnia and herzegovina": { code: "ba", name: "Bosnie-Herzégovine" },
  "north macedonia": { code: "mk", name: "Macédoine du Nord" },
  albania: { code: "al", name: "Albanie" },
  montenegro: { code: "me", name: "Monténégro" },
  // Pas de code ISO 3166-1 attribué : `xk` circule mais ne rend pas partout.
  kosovo: { code: null, name: "Kosovo" },
  cyprus: { code: "cy", name: "Chypre" },
  malta: { code: "mt", name: "Malte" },
  luxembourg: { code: "lu", name: "Luxembourg" },
  ukraine: { code: "ua", name: "Ukraine" },
  russia: { code: "ru", name: "Russie" },
  belarus: { code: "by", name: "Biélorussie" },
  moldova: { code: "md", name: "Moldavie" },
  lithuania: { code: "lt", name: "Lituanie" },
  latvia: { code: "lv", name: "Lettonie" },
  estonia: { code: "ee", name: "Estonie" },
  georgia: { code: "ge", name: "Géorgie" },
  armenia: { code: "am", name: "Arménie" },
  azerbaijan: { code: "az", name: "Azerbaïdjan" },
  kazakhstan: { code: "kz", name: "Kazakhstan" },
  israel: { code: "il", name: "Israël" },

  "united states": { code: "us", name: "États-Unis" },
  usa: { code: "us", name: "États-Unis" },
  canada: { code: "ca", name: "Canada" },
  mexico: { code: "mx", name: "Mexique" },
  brazil: { code: "br", name: "Brésil" },
  argentina: { code: "ar", name: "Argentine" },
  uruguay: { code: "uy", name: "Uruguay" },
  chile: { code: "cl", name: "Chili" },
  colombia: { code: "co", name: "Colombie" },
  peru: { code: "pe", name: "Pérou" },
  ecuador: { code: "ec", name: "Équateur" },
  paraguay: { code: "py", name: "Paraguay" },
  bolivia: { code: "bo", name: "Bolivie" },
  venezuela: { code: "ve", name: "Venezuela" },

  "saudi arabia": { code: "sa", name: "Arabie saoudite" },
  "united arab emirates": { code: "ae", name: "Émirats arabes unis" },
  qatar: { code: "qa", name: "Qatar" },
  kuwait: { code: "kw", name: "Koweït" },
  bahrain: { code: "bh", name: "Bahreïn" },
  oman: { code: "om", name: "Oman" },
  iran: { code: "ir", name: "Iran" },
  iraq: { code: "iq", name: "Irak" },

  egypt: { code: "eg", name: "Égypte" },
  morocco: { code: "ma", name: "Maroc" },
  algeria: { code: "dz", name: "Algérie" },
  tunisia: { code: "tn", name: "Tunisie" },
  "south africa": { code: "za", name: "Afrique du Sud" },
  nigeria: { code: "ng", name: "Nigeria" },
  ghana: { code: "gh", name: "Ghana" },
  senegal: { code: "sn", name: "Sénégal" },
  "cote d'ivoire": { code: "ci", name: "Côte d'Ivoire" },
  "ivory coast": { code: "ci", name: "Côte d'Ivoire" },
  cameroon: { code: "cm", name: "Cameroun" },

  japan: { code: "jp", name: "Japon" },
  "south korea": { code: "kr", name: "Corée du Sud" },
  "korea, south": { code: "kr", name: "Corée du Sud" },
  china: { code: "cn", name: "Chine" },
  india: { code: "in", name: "Inde" },
  thailand: { code: "th", name: "Thaïlande" },
  indonesia: { code: "id", name: "Indonésie" },
  malaysia: { code: "my", name: "Malaisie" },
  vietnam: { code: "vn", name: "Vietnam" },
  singapore: { code: "sg", name: "Singapour" },
  australia: { code: "au", name: "Australie" },
  "new zealand": { code: "nz", name: "Nouvelle-Zélande" },
};

export type ResolvedCountry = { code: string | null; name: string };

/**
 * Résout le libellé de pays d'une source.
 *
 * Un pays inconnu n'est pas une erreur : Transfermarkt couvre le monde entier,
 * et la table ci-dessus s'arrête aux nations qui apparaissent réellement dans un
 * feed mercato. L'inconnu ressort donc avec son nom source et sans code — la
 * carte et la puce de filtre restent justes, seul le drapeau manque.
 */
export function resolveCountry(raw?: string | null): ResolvedCountry | null {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  return COUNTRIES[value.toLowerCase()] ?? { code: null, name: value };
}

/**
 * Clé de filtre d'une ligne : le code quand il existe, sinon le nom réduit.
 *
 * Sans ce repli, tous les championnats hors table tomberaient dans le même
 * seau — « Kosovo » et « Irlande du Nord » deviendraient une seule puce, ce qui
 * afficherait un compte juste sur un libellé faux.
 */
export function countryKey(code?: string | null, name?: string | null): string | null {
  if (code) return code;
  if (!name) return null;
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
