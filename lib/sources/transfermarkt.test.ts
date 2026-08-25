import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  crestUrl,
  dedupeLabel,
  extractId,
  parsePlayerMarketValue,
  parseProbability,
  parsePublishedAt,
  parseRumours,
  portraitUrl,
  profileUrl,
  statusFor,
} from "./transfermarkt.ts";

const read = (name: string) =>
  readFileSync(new URL(`./__fixtures__.${name}.html`, import.meta.url), "utf-8");

const rumoursHtml = read("tm-rumours");
const playerHtml = read("tm-player");

describe("parseRumours", () => {
  const rows = parseRumours(rumoursHtml);

  it("moissonne toutes les lignes de la page", () => {
    assert.ok(rows.length >= 10, `${rows.length} lignes moissonnées`);
  });

  it("bâtit une clé naturelle stable sur joueur + club acheteur", () => {
    for (const row of rows) {
      assert.match(row.externalId, /^tm:rumour:[^:]+:[^:]+$/, row.playerName);
    }
    // Deux passages sur la même page doivent produire exactement les mêmes clés,
    // sans quoi l'upsert insérerait des doublons à chaque moisson.
    assert.deepEqual(
      parseRumours(rumoursHtml).map((r) => r.externalId),
      rows.map((r) => r.externalId),
    );
  });

  it("retient l'identifiant du joueur, clé de la résolution des valeurs", () => {
    const withId = rows.filter((r) => r.tmPlayerId);
    assert.ok(withId.length > 0);
    for (const row of withId) assert.match(String(row.tmPlayerId), /^\d+$/);
  });

  it("tire le pays et le championnat de la cellule du club acheteur", () => {
    const situated = rows.filter((r) => r.toCountry);
    assert.ok(situated.length > 0, "aucune ligne située");

    // Le pays vient du drapeau du championnat, pas de celui du joueur : la
    // colonne « Nat. » ne dit pas où le joueur pourrait signer.
    const first = rows[0];
    assert.equal(first.playerName, "Max Fenger");
    assert.equal(first.toClub, "Jagiellonia Bialystok");
    assert.equal(first.toCountry, "Poland");
    assert.equal(first.toCompetition, "Ekstraklasa");
  });

  it("n'invente pas de montant", () => {
    // La page des rumeurs n'en porte aucun. Un montant qui apparaîtrait ici
    // viendrait forcément d'une cellule mal lue.
    for (const row of rows) assert.equal(row.fee, null, row.playerName);
  });

  it("réclame les visuels en grand format", () => {
    for (const row of rows) {
      if (row.playerPhoto) assert.match(row.playerPhoto, /\/portrait\/big\//);
      if (row.toClubLogo) assert.match(row.toClubLogo, /\/wappen\/big\//);
    }
  });

  it("dérive le libellé de statut de la probabilité, sans le lire dans la page", () => {
    for (const row of rows) {
      assert.equal(row.statusLabel, statusFor(row.probability ?? null), row.playerName);
    }
  });
});

describe("parsePlayerMarketValue", () => {
  it("lit la valeur de marché de l'en-tête d'une vraie fiche", () => {
    assert.deepEqual(parsePlayerMarketValue(playerHtml), {
      market_value_eur: 220_000_000,
      market_value_label: "220 M€",
    });
  });

  it("ignore la date de dernière mise à jour qui suit le montant", () => {
    // Sans le retrait du paragraphe, « Last update: 22/07/2026 » serait le seul
    // nombre en vue sur un joueur non estimé, et on lirait « 22 € ».
    const html = `<div class="data-header__market-value-wrapper">-
      <p class="data-header__last-update">Last update: 22/07/2026</p></div>`;
    assert.equal(parsePlayerMarketValue(html), null);
  });

  it("rend null plutôt que zéro quand la fiche n'a pas de bloc de valeur", () => {
    assert.equal(parsePlayerMarketValue("<html><body>rien</body></html>"), null);
  });
});

describe("profileUrl", () => {
  it("s'appuie sur le seul identifiant, le segment de nom étant décoratif", () => {
    assert.equal(profileUrl("418560"), "https://www.transfermarkt.com/-/profil/spieler/418560");
  });
});

describe("aides de lecture", () => {
  it("replie les libellés que la page répète deux fois", () => {
    assert.equal(dedupeLabel("Sans clubSans club"), "Sans club");
    assert.equal(dedupeLabel("  Paris   Saint-Germain "), "Paris Saint-Germain");
    // Un mot dont les deux moitiés coïncident par hasard ne doit pas être coupé.
    assert.equal(dedupeLabel("Toto"), "Toto");
  });

  it("distingue une case vide d'une probabilité nulle", () => {
    assert.equal(parseProbability("31 %"), 31);
    assert.equal(parseProbability("0 %"), 0);
    assert.equal(parseProbability("?"), null);
    assert.equal(parseProbability(""), null);
  });

  it("lit une date de publication en heure d'Europe centrale", () => {
    const date = parsePublishedAt("25.08.2026 - 11:10");
    assert.equal(date?.toISOString(), "2026-08-25T09:10:00.000Z");
    assert.equal(parsePublishedAt("hier"), null);
  });

  it("n'accepte comme visuel que ce qui vient bien du bon chemin", () => {
    assert.equal(portraitUrl("https://exemple.test/portrait/medium/1.jpg"), null);
    assert.equal(crestUrl("https://img.a.transfermarkt.technology/portrait/big/1.png"), null);
  });

  it("extrait un identifiant de profil ou de club, et rien d'autre", () => {
    assert.equal(extractId("/max-fenger/profil/spieler/578920", "spieler"), "578920");
    assert.equal(extractId("/jagiellonia/startseite/verein/2300", "verein"), "2300");
    assert.equal(extractId("/max-fenger/profil/spieler/578920", "verein"), null);
    assert.equal(extractId(undefined, "spieler"), null);
  });
});
