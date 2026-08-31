import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseArticle, parseFeed, splitTitle } from "./maxifoot.ts";

const raw = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
const feedXml = new TextDecoder("utf-8").decode(raw("maxifoot-rss.xml"));
const article = (n: number) =>
  parseArticle(new TextDecoder("iso-8859-1").decode(raw(`maxifoot-article-${n}.html`)));

describe("parseFeed", () => {
  const items = parseFeed(feedXml);

  it("lit les entrées du flux", () => {
    assert.equal(items.length, 25);
    for (const item of items) {
      assert.match(item.url, /^https:\/\/www\.maxifoot\.fr\//);
      assert.ok(item.title.length > 0);
    }
  });

  it("décode les entités des titres", () => {
    // Sans décodage XML, on lirait « 100 M&euro; » et « Bar&ccedil;a ».
    const titles = items.map((i) => i.title);
    assert.ok(titles.some((t) => t.includes("100 M€")), "montant mal décodé");
    assert.ok(!titles.some((t) => t.includes("&")), "entité non résolue");
  });

  it("garde une clé stable par article", () => {
    const guids = new Set(items.map((i) => i.guid));
    assert.equal(guids.size, items.length, "guid dupliqué : on relirait le même article");
  });

  it("lit la date de publication", () => {
    assert.ok(items.every((i) => i.publishedAt instanceof Date));
  });
});

describe("splitTitle", () => {
  it("sépare le club sujet du titre réel", () => {
    assert.deepEqual(splitTitle("Mercato Lille : Bouaddi à City pour 100 M€ (officiel)"), {
      club: "Lille",
      headline: "Bouaddi à City pour 100 M€ (officiel)",
    });
  });

  it("laisse passer un titre hors format", () => {
    assert.deepEqual(splitTitle("Un titre libre"), { club: null, headline: "Un titre libre" });
  });
});

describe("parseArticle", () => {
  it("rend le corps en texte, sans balises", () => {
    const a = article(0);
    assert.equal(a.title, "PSG : Liverpool optimiste pour Barcola");
    assert.match(a.text, /^Comme nous vous l'indiquions ce mardi/);
    assert.ok(!a.text.includes("<"), "balise résiduelle");
  });

  it("retire les encarts publicitaires injectés dans le corps", () => {
    // Les pubs sont des <div> imbriqués AU MILIEU du texte : un simple retrait
    // de balises laisserait « emplacement publicitaire » en plein article, et
    // le garde-fou de citation validerait alors une phrase qui n'existe pas.
    for (let n = 0; n < 5; n += 1) {
      assert.ok(!article(n).text.includes("publicitaire"), `article ${n}`);
    }
  });

  it("s'arrête à la fin de la brève", () => {
    // Au-delà de <b id=momo>, la page enchaîne sur la navigation et les brèves
    // voisines — du texte d'autres transferts, qui pollueraient l'extraction.
    const a = article(0);
    assert.match(a.text, /Une affaire à suivre avec attention\.$/);
  });

  it("décode correctement les accents", () => {
    const a = article(0);
    assert.ok(a.text.includes("brève"), "ISO-8859-1 mal décodé");
    assert.ok(!a.text.includes("Ã"), "double décodage");
  });

  it("relève les joueurs balisés par la source", () => {
    const a = article(0);
    assert.deepEqual(a.playerHints, [{ sourceId: "245910", name: "Barcola" }]);
  });

  it("accepte un article sans joueur balisé", () => {
    // 1 article sur 5 n'en porte pas : c'est un indice, pas une garantie, et
    // l'extraction doit tenir sans.
    const a = article(3);
    assert.deepEqual(a.playerHints, []);
    assert.match(a.text, /Malick Fofana/);
  });

  it("produit des textes courts, ce qui dimensionne le budget LLM", () => {
    // ~700 caractères, soit ~200 tokens : le corps entier tient dans le prompt
    // sans fenêtrage. C'est ce qui rend l'extraction viable sur un CPU.
    for (let n = 0; n < 5; n += 1) {
      const { text } = article(n);
      assert.ok(text.length > 300, `article ${n} trop court : ${text.length}`);
      assert.ok(text.length < 3000, `article ${n} trop long : ${text.length}`);
    }
  });

  it("rend un corps vide plutôt que d'échouer sur une page remaniée", () => {
    assert.deepEqual(parseArticle("<html><body><h1>Titre</h1></body></html>"), {
      title: "Titre",
      text: "",
      playerHints: [],
    });
  });
});
