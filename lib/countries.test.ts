import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countryKey, resolveCountry } from "./countries.ts";
import { flagEmoji } from "./format.ts";

describe("resolveCountry", () => {
  it("francise les pays du feed", () => {
    assert.deepEqual(resolveCountry("Poland"), { code: "pl", name: "Pologne" });
    assert.deepEqual(resolveCountry("Germany"), { code: "de", name: "Allemagne" });
    assert.deepEqual(resolveCountry("Saudi Arabia"), { code: "sa", name: "Arabie saoudite" });
  });

  it("est insensible à la casse et aux espaces de la source", () => {
    assert.deepEqual(resolveCountry("  SPAIN  "), { code: "es", name: "Espagne" });
    assert.deepEqual(resolveCountry("south korea"), { code: "kr", name: "Corée du Sud" });
  });

  it("donne aux nations britanniques leur propre drapeau", () => {
    // L'Union Jack sur la Premier League serait une faute visible : l'Angleterre
    // a son drapeau, et c'est le championnat le plus regardé du feed.
    assert.deepEqual(resolveCountry("England"), { code: "gb-eng", name: "Angleterre" });
    assert.equal(flagEmoji("gb-eng"), "🏴󠁧󠁢󠁥󠁮󠁧󠁿");
    assert.notEqual(flagEmoji("gb-eng"), flagEmoji("gb-sct"));
  });

  it("garde le nom d'un pays absent de la table, et le prive seulement du drapeau", () => {
    // Transfermarkt couvre le monde entier ; la table s'arrête aux nations qui
    // apparaissent dans un feed mercato. L'inconnu doit rester lisible.
    assert.deepEqual(resolveCountry("Faroe Islands"), { code: null, name: "Faroe Islands" });
    assert.equal(flagEmoji(null), "");
  });

  it("rend null sur une absence, pour que la carte n'affiche pas une puce vide", () => {
    assert.equal(resolveCountry(null), null);
    assert.equal(resolveCountry("   "), null);
  });
});

describe("countryKey", () => {
  it("prend le code quand il existe", () => {
    assert.equal(countryKey("pl", "Pologne"), "pl");
    assert.equal(countryKey("gb-eng", "Angleterre"), "gb-eng");
  });

  it("replie sur le nom réduit, sans confondre deux pays sans code", () => {
    // Sans ce repli, « Kosovo » et « Irlande du Nord » tomberaient dans le même
    // seau : un compte juste affiché sous un libellé faux.
    assert.equal(countryKey(null, "Irlande du Nord"), "irlande-du-nord");
    assert.equal(countryKey(null, "Kosovo"), "kosovo");
    assert.notEqual(countryKey(null, "Kosovo"), countryKey(null, "Irlande du Nord"));
  });

  it("rend null quand la ligne n'est pas située", () => {
    assert.equal(countryKey(null, null), null);
  });
});
