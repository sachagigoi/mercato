import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseArticle, parseFeed } from "../sources/maxifoot.ts";
import { findAmounts, prefilter, qualifierNear, splitSentences } from "./prefilter.ts";

const raw = (name: string) => readFileSync(new URL(`../sources/__fixtures__/${name}`, import.meta.url));
const article = (n: number) =>
  parseArticle(new TextDecoder("iso-8859-1").decode(raw(`maxifoot-article-${n}.html`)));

describe("findAmounts", () => {
  it("lit les montants tels que la presse française les écrit", () => {
    assert.deepEqual(findAmounts("un transfert à 50 M€").map((a) => a.eur), [50_000_000]);
    assert.deepEqual(findAmounts("9,3 M€ bonus compris").map((a) => a.eur), [9_300_000]);
    assert.deepEqual(findAmounts("contre 18 millions d'euros").map((a) => a.eur), [18_000_000]);
    assert.deepEqual(findAmounts("estimé à 1,2 milliard d'euros").map((a) => a.eur), [1_200_000_000]);
  });

  it("relève plusieurs montants dans une même phrase", () => {
    // « 45 M€ + 5 M€ de bonus » : la base et le bonus doivent rester distincts,
    // sinon la carte annoncerait 50 M€ comme un prix ferme.
    assert.deepEqual(findAmounts("45 M€ plus 5 M€ de bonus").map((a) => a.eur), [45_000_000, 5_000_000]);
  });

  it("ne prend pas un nombre nu pour un montant", () => {
    // Le piège qui compte : « 50 000 abonnés » ou « 23 ans » ne sont pas des prix.
    assert.deepEqual(findAmounts("Barcola (23 ans) et ses 50 000 abonnés"), []);
    assert.deepEqual(findAmounts("42 matchs toutes compétitions"), []);
  });
});

describe("splitSentences", () => {
  it("ne coupe pas sur les décimales ni les points d'abréviation", () => {
    const s = splitSentences("Il part pour 9,3 M€. Le club a confirmé.");
    assert.equal(s.length, 2);
    assert.match(s[0], /9,3 M€\.$/);
  });

  it("rend des phrases exploitables comme citations", () => {
    for (let n = 0; n < 5; n += 1) {
      for (const s of splitSentences(article(n).text)) {
        assert.ok(s.length > 0);
        assert.equal(s, s.trim());
      }
    }
  });
});

describe("prefilter", () => {
  it("laisse passer un article de Ligue 1", () => {
    const a = article(0); // PSG : Liverpool optimiste pour Barcola
    const r = prefilter(a);
    assert.equal(r.pass, true);
    assert.ok(r.mentions.some((c) => c.name === "Paris Saint-Germain"));
  });

  it("attrape un transfert entrant autant qu'un sortant", () => {
    // Genoa -> Rennes : le club de L1 est l'acheteur, et l'article ne parle
    // de la Ligue 1 qu'en passant. Il doit quand même passer la porte.
    const r = prefilter(article(2));
    assert.equal(r.pass, true);
    // L'OM est cité aussi — Vitinha en vient. Une mention n'est pas une partie
    // au transfert, et le préfiltre n'a pas à trancher : il ouvre la porte.
    assert.ok(r.mentions.some((c) => c.name === "Stade Rennais"));
  });

  it("écarte ce qui ne touche pas la Ligue 1", () => {
    const r = prefilter({ title: "Chelsea : Delap vers Nottingham pour 52,5 M€", text: "Un long texte sans aucun club français, mais avec un montant bien visible de 52,5 M€." });
    assert.equal(r.pass, false);
    assert.equal(r.reason, "hors-ligue-1");
  });

  it("laisse passer un article L1 sans montant", () => {
    // Un club qui se positionne fait vivre une piste même sans chiffre : c'est
    // l'extraction qui rendra une déclaration sans montant, pas le préfiltre
    // qui doit la jeter.
    const r = prefilter({ title: "OL : Fofana veut rester", text: "L'ailier belge de l'Olympique Lyonnais souhaite rester cette saison selon son entourage." });
    assert.equal(r.pass, true);
    assert.deepEqual(r.moneyAt, []);
  });

  it("refuse un corps vide plutôt que d'appeler le modèle pour rien", () => {
    const r = prefilter({ title: "OM : une piste", text: "   " });
    assert.equal(r.pass, false);
    assert.equal(r.reason, "corps-vide");
  });

  it("prend en compte le montant qui n'est que dans le titre", () => {
    // Un tiers des titres Maxifoot portent le chiffre sans que le corps le
    // répète. Analyser le corps seul les perdrait.
    const r = prefilter({ title: "Angers : Ekomié à Wrexham pour 9,3 M€", text: "Le latéral gauche va prendre la direction du pays de Galles." });
    assert.ok(r.moneyAt.includes(0), "montant du titre ignoré");
  });

  it("réduit réellement le flux — c'est ce qui rend l'inférence CPU tenable", () => {
    const items = parseFeed(new TextDecoder().decode(raw("maxifoot-rss.xml")));
    const passing = items.filter((i) => prefilter({ title: i.title, text: i.teaser ?? "" }).pass);
    // Mesuré sur ce flux : une dizaine sur 25. Le seuil est large exprès —
    // le test protège l'ordre de grandeur, pas un chiffre du jour.
    assert.ok(passing.length >= 5 && passing.length <= 15, `${passing.length} sur ${items.length}`);
  });
});

describe("splitSentences — phrases recollées", () => {
  it("coupe un point sans espace après lui", () => {
    // Maxifoot recolle régulièrement deux phrases. Sans cette coupure, la
    // citation affichée en emporte deux pour le prix d'une.
    const out = splitSentences("L'OL réclame 40 M€ pour son joueur.Surtout, Fofana hésite.");
    assert.equal(out.length, 2);
    assert.equal(out[1], "Surtout, Fofana hésite.");
  });

  it("ne coupe ni les initiales ni les abréviations", () => {
    // « M.Dupont » n'est pas une frontière de phrase : la minuscule exigée
    // avant le point est ce qui l'en distingue.
    assert.equal(splitSentences("Selon M.Dupont, le deal avance.").length, 1);
    assert.equal(splitSentences("Un chèque de 9,3 M€ est évoqué.").length, 1);
  });
});

describe("qualifierNear", () => {
  const nuanceOf = (text: string) => {
    const [amount] = findAmounts(text);
    assert.ok(amount, `aucun montant dans « ${text} »`);
    return qualifierNear(text, amount.at);
  };

  it("lit les nuances que le modèle ne remplit jamais", () => {
    // Deux passages réels : « environ 35 millions d'euros » et « au moins
    // 25 millions d'euros » sont tous deux ressortis du modèle en `exact`.
    assert.equal(nuanceOf("les Black Cats pourraient débourser environ 35 millions d'euros"), "environ");
    assert.equal(nuanceOf("Contraint de vendre pour au moins 25 millions d’euros"), "minimum");
    assert.equal(nuanceOf("une offre pouvant aller jusqu'à 40 M€"), "maximum");
    assert.equal(nuanceOf("aux alentours de 12 M€"), "environ");
    assert.equal(nuanceOf("plus de 8 millions d'euros"), "minimum");
  });

  it("ne voit pas de nuance là où il n'y en a pas", () => {
    // Inventer « environ » sur un chiffre ferme serait pire que de n'en
    // afficher aucun : ça ferait douter d'un montant qui ne le mérite pas.
    assert.equal(nuanceOf("le LOSC a annoncé le transfert pour 100 M€"), null);
    assert.equal(nuanceOf("l'OL réclame 40 M€ pour céder son ailier"), null);
  });

  it("ne regarde pas au-delà de la phrase précédente", () => {
    // La fenêtre est courte exprès : « environ » vingt mots plus tôt ne
    // qualifie pas ce chiffre-ci.
    assert.equal(
      nuanceOf("Environ, disait-il, mais le club a finalement annoncé un transfert sec de 30 M€"),
      null,
    );
  });
});
