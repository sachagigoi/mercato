import type { RawTransferInput } from "@/lib/ingest";

/**
 * Source de démonstration pour la Phase 3.
 *
 * Elle a la signature exacte du futur scraper Transfermarkt, ce qui permet de
 * bâtir et d'éprouver tout le pipeline avant qu'une ligne de scraping existe.
 *
 * Le jeu est volontairement sale — il reproduit ce qu'une vraie page renvoie :
 * montants dans trois formats, doublon entre le bloc « top » et le bloc
 * « récentes », et une ligne inexploitable. Un pipeline qui n'est testé que sur
 * de la donnée propre casse à la première moisson réelle.
 */
export async function fetchFixtureRumours(): Promise<unknown[]> {
  const rows: (RawTransferInput | unknown)[] = [
    {
      externalId: "tm:rumour:418560:583",
      playerName: "Rayan Cherki",
      nationalityCode: "FR",
      fromClub: "Olympique Lyonnais",
      toClub: "Paris Saint-Germain",
      fee: "€45.00m",
      type: "RUMOUR",
      probability: 78,
      statusLabel: "Piste chaude",
      source: "Transfermarkt",
      sourceUrl: "https://www.transfermarkt.fr/statistik/aktuellegeruechte",
    },
    {
      externalId: "tm:rumour:735291:281",
      playerName: "Bruno Cardoso",
      nationalityCode: "PT",
      fromClub: "SL Benfica",
      toClub: "Manchester City",
      fee: "€82.00m",
      type: "RUMOUR",
      probability: 91,
      statusLabel: "Accord imminent",
      source: "Transfermarkt",
    },
    {
      externalId: "tm:transfer:602188:11",
      playerName: "Lucas Bergeron",
      nationalityCode: "fr",
      fromClub: "Stade Rennais",
      toClub: "Arsenal",
      fee: "€32.00m",
      type: "TRANSFER",
      statusLabel: "Officialisé",
      source: "Transfermarkt",
    },
    {
      externalId: "tm:transfer:339104:15",
      playerName: "Kwame Asante",
      fromClub: "Chelsea",
      toClub: "Bayer Leverkusen",
      fee: "loan transfer",
      type: "TRANSFER",
      statusLabel: "Officialisé",
      source: "Transfermarkt",
    },
    {
      externalId: "tm:transfer:774920:417",
      playerName: "Ismaël Diarra",
      nationalityCode: "SN",
      fromClub: "FC Nantes",
      toClub: "OGC Nice",
      fee: "free transfer",
      type: "TRANSFER",
      statusLabel: "Officialisé",
      source: "Transfermarkt",
    },
    {
      externalId: "tm:extension:150281:506",
      playerName: "Matteo Ferrara",
      nationalityCode: "IT",
      fromClub: "Juventus",
      toClub: "Juventus",
      fee: "-",
      type: "EXTENSION",
      statusLabel: "Jusqu'en 2029",
      source: "Transfermarkt",
    },
    // Doublon : la même rumeur apparaît dans le bloc « top » et dans « récentes ».
    // La seconde occurrence porte une probabilité rafraîchie, c'est elle qui doit gagner.
    {
      externalId: "tm:rumour:418560:583",
      playerName: "Rayan Cherki",
      nationalityCode: "FR",
      fromClub: "Olympique Lyonnais",
      toClub: "Paris Saint-Germain",
      fee: "€45.00m",
      type: "RUMOUR",
      probability: 81,
      statusLabel: "Piste chaude",
      source: "Transfermarkt",
    },
    // Ligne inexploitable : pas de nom de joueur. Elle doit être écartée et
    // journalisée, sans faire échouer la moisson.
    {
      externalId: "tm:rumour:000000:000",
      fromClub: "Inconnu",
      type: "RUMOUR",
    },
  ];

  return rows;
}
