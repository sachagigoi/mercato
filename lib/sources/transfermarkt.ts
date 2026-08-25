import * as cheerio from "cheerio";

import type { RawTransferInput } from "../ingest.ts";

/**
 * Locale `.com` plutôt que `.fr`, contrairement au choix initial.
 *
 * Deux raisons, dans cet ordre : `www.transfermarkt.fr` n'est pas joignable
 * depuis l'environnement d'exécution, et surtout la locale ne coûte presque
 * rien ici — les libellés de statut sont dérivés de la probabilité par
 * `statusFor()`, pas lus dans la page. Reste les noms de clubs, que la version
 * anglaise rend d'ailleurs plus proches de ceux d'API-Football
 * (« Eintracht Frankfurt » plutôt que « Eintracht Francfort »).
 */
export const RUMOURS_URL = "https://www.transfermarkt.com/statistik/aktuellegeruechte";

/**
 * Accès HTTP, injecté — même posture que pour API-Football : le parseur se
 * teste contre du HTML enregistré, sans jamais sortir sur le réseau.
 */
export interface HtmlFetcher {
  get(url: string): Promise<string>;
}

export function createHtmlFetcher(): HtmlFetcher {
  return {
    async get(url) {
      const res = await fetch(url, {
        headers: {
          // User-Agent honnête : on s'annonce comme un navigateur courant plutôt
          // que de se déguiser. Volume faible, une page toutes les 30 minutes.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept-Language": "fr-FR,fr;q=0.9",
        },
      });
      if (!res.ok) throw new Error(`Transfermarkt : HTTP ${res.status}`);
      return res.text();
    },
  };
}

/**
 * Transfermarkt répète souvent le libellé dans le HTML (« Sans clubSans club »),
 * parce que deux nœuds portent le même texte. On replie la répétition exacte.
 */
export function dedupeLabel(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const half = clean.length / 2;
  if (clean.length % 2 === 0 && clean.slice(0, half) === clean.slice(half)) {
    return clean.slice(0, half).trim();
  }
  return clean;
}

/** « 31 % » -> 31. Une case vide ou « ? » ne vaut pas zéro : elle vaut inconnu. */
export function parseProbability(value: string): number | null {
  const match = /(\d{1,3})\s*%/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** « 25.08.2026 - 11:10 » -> Date. Transfermarkt publie en heure d'Europe centrale. */
export function parsePublishedAt(value: string): Date | null {
  const m = /(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [, d, mo, y, h, min] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${min}:00+02:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Portrait du joueur, en grand format.
 *
 * La page sert des vignettes `/portrait/medium/` de 100 × 130 px — sous la
 * porte de qualité de 200 px du worker de détourage, qui les écarterait toutes.
 * Le même identifiant en `/portrait/big/` rend du 300 × 390 px, cadré
 * tête-épaules sur fond flou : le point de départ idéal pour le détourage.
 *
 * Conséquence : les portraits ne coûtent plus rien au quota API-Football, qui
 * n'a plus à résoudre que les écussons de clubs.
 */
export function portraitUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const url = raw.split("?")[0];
  if (!/img\.a\.transfermarkt\.technology\/portrait\//.test(url)) return null;
  return url.replace("/portrait/medium/", "/portrait/big/");
}

/** Extrait l'identifiant Transfermarkt d'une URL de profil ou de club. */
export function extractId(href: string | undefined, kind: "spieler" | "verein"): string | null {
  if (!href) return null;
  const m = new RegExp(`/${kind}/(\\d+)`).exec(href);
  return m ? m[1] : null;
}

/**
 * Analyse la page des rumeurs récentes.
 *
 * Structure vérifiée sur la page réelle :
 *   td0 joueur (lien /profil/spieler/{id})  td1 âge      td2 drapeau
 *   td3 club actuel                          td4 club intéressé
 *   td5 date de publication                  td6 probabilité de transfert
 *
 * Le parseur est volontairement tolérant : une ligne dont on ne peut tirer ni
 * joueur ni club acheteur est ignorée, sans interrompre les autres. Une page
 * remaniée doit dégrader la moisson, jamais la faire échouer.
 */
export function parseRumours(html: string): RawTransferInput[] {
  const $ = cheerio.load(html);
  const out: RawTransferInput[] = [];

  const rows = $("table.items > tbody > tr").filter((_, el) =>
    /odd|even/.test($(el).attr("class") ?? ""),
  );

  rows.each((_, el) => {
    const tds = $(el).children("td");
    if (tds.length < 7) return;

    const playerLink = $(tds[0]).find('a[href*="/profil/spieler/"]').first();
    const playerName = dedupeLabel(playerLink.text());
    const playerId = extractId(playerLink.attr("href"), "spieler");
    if (!playerName) return;

    // Les images sont en chargement différé : l'URL réelle est dans data-src.
    const portraitImg = $(tds[0]).find("img").first();
    const playerPhoto = portraitUrl(portraitImg.attr("data-src") ?? portraitImg.attr("src"));

    const fromLink = $(tds[3]).find("a").first();
    const toLink = $(tds[4]).find("a").first();
    const fromClub = frenchClub(dedupeLabel(fromLink.attr("title") ?? ""));
    const toClub = frenchClub(dedupeLabel(toLink.attr("title") ?? ""));
    const toClubId = extractId(toLink.attr("href"), "verein");
    if (!toClub) return;

    // La cellule de probabilité contient aussi un lien vers le forum : on ne
    // garde que le texte propre du td.
    const probabilityText = $(tds[6]).clone().children().remove().end().text();
    const probability = parseProbability(probabilityText);

    const publishedAt = parsePublishedAt($(tds[5]).text());
    // Clé naturelle : le couple joueur + club acheteur identifie la rumeur de
    // façon stable d'une moisson à l'autre. Repli sur les noms si l'un des
    // identifiants manque, pour ne pas perdre la ligne.
    const externalId = `tm:rumour:${playerId ?? slug(playerName)}:${toClubId ?? slug(toClub)}`;

    out.push({
      externalId,
      playerName,
      playerPhoto,
      // La colonne drapeau donne un pays en toutes lettres (« Danemark »), pas un
      // code ISO. Le convertir demanderait une table de correspondance FR -> ISO :
      // à faire quand le drapeau sur la carte le justifiera, pas avant.
      nationalityCode: null,
      fromClub: fromClub || null,
      toClub,
      fee: null, // la page des rumeurs n'affiche pas de montant
      type: "RUMOUR",
      probability,
      statusLabel: statusFor(probability),
      source: "Transfermarkt",
      sourceUrl: RUMOURS_URL,
      publishedAt: publishedAt ?? undefined,
    });
  });

  return out;
}

/**
 * Les noms de clubs restent tels quels — ils sont internationaux et servent
 * aussi de clé de recherche API-Football. Seuls les libellés génériques de la
 * version anglaise sont francisés, parce qu'eux s'affichent sur la carte.
 */
const CLUB_LABELS: Record<string, string> = {
  "Without Club": "Sans club",
  "Retired": "Retraité",
  "Career break": "Pause carrière",
  "Unknown": "Inconnu",
};

const frenchClub = (value: string) => CLUB_LABELS[value] ?? value;

const slug = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Libellé de statut dérivé de la probabilité.
 *
 * Transfermarkt ne fournit pas de libellé, seulement un pourcentage. On le
 * dérive plutôt que de laisser la pastille vide — et comme la couleur vient
 * déjà de `accentOf()`, les deux restent cohérents par construction.
 */
export function statusFor(probability: number | null): string {
  if (probability === null) return "Rumeur";
  if (probability >= 90) return "Accord imminent";
  if (probability >= 70) return "Piste chaude";
  if (probability >= 40) return "Discussions en cours";
  if (probability >= 15) return "Piste explorée";
  return "Piste froide";
}

export async function fetchRumours(fetcher: HtmlFetcher = createHtmlFetcher()) {
  return parseRumours(await fetcher.get(RUMOURS_URL));
}
