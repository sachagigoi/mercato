import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_COUNTRIES,
  countryOptions,
  filterOf,
  isFilterKey,
  matchesCountry,
} from "./filters.ts";
import type { Transfer } from "./types.ts";

let seq = 0;
const row = (partial: Partial<Transfer>): Transfer =>
  ({
    id: `row-${(seq += 1)}`,
    type: "RUMOUR",
    player_name: "Joueur",
    probability_score: null,
    to_country_code: null,
    to_country_name: null,
    ...partial,
  }) as Transfer;

const france = { to_country_code: "fr", to_country_name: "France" };
const angleterre = { to_country_code: "gb-eng", to_country_name: "Angleterre" };

describe("matchesCountry", () => {
  it("laisse tout passer sous « tous les pays »", () => {
    assert.equal(matchesCountry(row(france), ALL_COUNTRIES), true);
    assert.equal(matchesCountry(row({}), ALL_COUNTRIES), true);
  });

  it("retient le pays du club acheteur", () => {
    assert.equal(matchesCountry(row(france), "fr"), true);
    assert.equal(matchesCountry(row(angleterre), "fr"), false);
  });

  it("écarte les lignes que la source ne situe pas", () => {
    // Elles restent visibles sous « Tous les pays » : c'est ce que la puce
    // annonce, et les faire apparaître sous un pays serait faux.
    assert.equal(matchesCountry(row({}), "fr"), false);
  });
});

describe("countryOptions", () => {
  const rows = [
    row(angleterre),
    row(angleterre),
    row(angleterre),
    row(france),
    row(france),
    row({ to_country_code: "it", to_country_name: "Italie" }),
    row({}),
  ];

  it("ouvre sur « tous les pays », compté sur le jeu entier", () => {
    const [first] = countryOptions(rows);
    assert.equal(first.key, ALL_COUNTRIES);
    // 7 et non 6 : la ligne non située est bien dans le feed.
    assert.equal(first.count, rows.length);
  });

  it("classe les pays du plus fourni au moins fourni", () => {
    assert.deepEqual(
      countryOptions(rows)
        .slice(1)
        .map((c) => [c.label, c.count]),
      [
        ["Angleterre", 3],
        ["France", 2],
        ["Italie", 1],
      ],
    );
  });

  it("ne fabrique pas de puce pour une ligne non située", () => {
    assert.equal(countryOptions([row({})]).length, 1);
  });

  it("départage deux pays à égalité par l'alphabet, pour un ordre stable", () => {
    // Sans départage, l'ordre des puces dépendrait de celui des lignes, donc
    // changerait à chaque moisson sous les doigts du lecteur.
    const tied = [row(france), row({ to_country_code: "es", to_country_name: "Espagne" })];
    assert.deepEqual(
      countryOptions(tied)
        .slice(1)
        .map((c) => c.label),
      ["Espagne", "France"],
    );
  });

  it("garde une puce à zéro quand le pays existe ailleurs dans le feed", () => {
    // Le cas qui compte : le lecteur a choisi la France, puis « Officialisés ».
    // La puce France doit rester là, à zéro, pour qu'il puisse revenir en
    // arrière — et pour que l'état vide sache de quel pays il parle.
    const all = [row(france), row(angleterre)];
    const officials = [row(angleterre)];

    const options = countryOptions(all, officials);
    const byLabel = Object.fromEntries(options.map((c) => [c.label, c.count]));

    assert.equal(byLabel["France"], 0);
    assert.equal(byLabel["Angleterre"], 1);
    assert.equal(byLabel["Tous les pays"], 1);
  });

  it("ne compte que sur le second jeu, et n'invente pas de puce depuis lui", () => {
    const options = countryOptions([row(france)], [row(angleterre)]);
    assert.deepEqual(
      options.slice(1).map((c) => [c.label, c.count]),
      [["France", 0]],
    );
  });

  it("transporte le code du drapeau tel quel", () => {
    const [, first] = countryOptions([row(angleterre)]);
    assert.equal(first.code, "gb-eng");
  });
});

describe("composition des deux axes", () => {
  it("croise le type et le pays", () => {
    // « Les rumeurs chaudes en Angleterre » : c'est exactement ce que la barre
    // doit permettre, et ce que l'URL doit pouvoir porter.
    const rows = [
      row({ ...angleterre, type: "RUMOUR", probability_score: 88 }),
      row({ ...angleterre, type: "RUMOUR", probability_score: 12 }),
      row({ ...france, type: "RUMOUR", probability_score: 91 }),
      row({ ...angleterre, type: "TRANSFER" }),
    ];

    const hot = filterOf("hot");
    const visible = rows.filter(hot.match).filter((t) => matchesCountry(t, "gb-eng"));

    assert.equal(visible.length, 1);
    assert.equal(visible[0].probability_score, 88);
  });

  it("garde les clés de type connues et rejette le reste", () => {
    assert.equal(isFilterKey("hot"), true);
    assert.equal(isFilterKey("gb-eng"), false);
    assert.equal(isFilterKey(null), false);
  });
});
