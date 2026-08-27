import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { BytesFetcher } from "../articles.ts";
import { publishDeclarations, type DeclarationRow } from "../declarations.ts";
import { createMaxifoot } from "../sources/maxifoot.ts";
import { acceptClaim, OLLAMA_FORMAT, STANCES } from "./claims.ts";
import { prefilter } from "./prefilter.ts";
import { buildUserPrompt, SYSTEM_PROMPT, type Extractor } from "./ollama.ts";
import { rejectionRate, runSource, toPublishPayload } from "./run.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../sources/__fixtures__/${name}`, import.meta.url)));

/**
 * Le flux et les articles servis depuis les fixtures : le passage complet se
 * rejoue sans réseau, ce qui en fait aussi le banc d'essai des modèles.
 */
function fixtureFetcher(): BytesFetcher & { calls: string[] } {
  const calls: string[] = [];
  // Les liens du flux, dans l'ordre des articles enregistrés.
  const byUrl = new Map([
    ["https://www.maxifoot.fr/psg/liverpool-optimiste-pour-barcola-foot-462525.htm", "maxifoot-article-0.html"],
    ["https://www.maxifoot.fr/lille/bouaddi-a-city-pour-100-m-euro-officiel-foot-462564.htm", "maxifoot-article-1.html"],
    ["https://www.maxifoot.fr/genoa/un-interet-de-rennes-pour-vitinha-foot-462519.htm", "maxifoot-article-2.html"],
    ["https://www.maxifoot.fr/lyon/fofana-veut-rester-foot-462544.htm", "maxifoot-article-3.html"],
    ["https://www.maxifoot.fr/angers/ekomie-a-wrexham-pour-9-3-m-euro-foot-462517.htm", "maxifoot-article-4.html"],
  ]);

  return {
    calls,
    async get(url) {
      calls.push(url);
      if (url.includes("rss")) return fixture("maxifoot-rss.xml");
      const name = byUrl.get(url);
      if (!name) throw new Error(`HTTP 404 : ${url}`);
      return fixture(name);
    },
  };
}

/** Modèle scripté : il désigne toujours la première phrase portant un montant. */
function fakeExtractor(reply: (sentences: readonly string[]) => unknown[]): Extractor & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model: "test",
    promptVersion: "1",
    async extract(sentences) {
      prompts.push(buildUserPrompt(sentences));
      return { claims: reply(sentences), raw: "" };
    },
  };
}

const noSleep = async () => {};

/** Premier nom capitalisé du texte : de quoi bâtir une déclaration crédible. */
function playerOf(sentences: readonly string[]): string | null {
  const m = /\b([A-ZÀ-Þ][a-zà-ÿ]+(?:-[A-ZÀ-Þ][a-zà-ÿ]+)?)\s+\((\d{2}) ans\)/.exec(sentences.join(" "));
  return m ? m[1] : null;
}

describe("runSource", () => {
  it("n'appelle le modèle que sur les articles de Ligue 1", async () => {
    const http = fixtureFetcher();
    const extractor = fakeExtractor(() => []);

    const report = await runSource(createMaxifoot(http), extractor, { sleep: noSleep });

    assert.equal(report.listed, 25);
    // Seuls les articles enregistrés répondent ; les autres tombent en 404 et
    // sont comptés en erreur sans faire échouer le passage.
    assert.ok(report.extracted <= report.fetched);
    assert.ok(report.extracted > 0, "aucun article soumis");
    assert.ok(report.listed > report.fetched, "le préfiltre n'a rien écarté avant le fetch");
  });

  it("ne récupère jamais un article déjà vu", async () => {
    const http = fixtureFetcher();
    const seen = new Set(["https://www.maxifoot.fr/psg/liverpool-optimiste-pour-barcola-foot-462525.htm"]);

    await runSource(createMaxifoot(http), fakeExtractor(() => []), { seen, sleep: noSleep });

    assert.ok(!http.calls.some((u) => u.includes("barcola-foot-462525")), "article déjà vu rechargé");
  });

  it("numérote les phrases dans le prompt", async () => {
    const http = fixtureFetcher();
    const extractor = fakeExtractor(() => []);

    await runSource(createMaxifoot(http), extractor, { sleep: noSleep, limit: 1 });

    assert.ok(extractor.prompts.length > 0);
    assert.match(extractor.prompts[0], /^\[0\] /);
    assert.match(extractor.prompts[0], /\n\[1\] /);
  });

  it("retient une déclaration adossée au texte réel", async () => {
    const http = fixtureFetcher();
    // Le modèle désigne la phrase du montant sur la brève Bouaddi -> City.
    const extractor = fakeExtractor((sentences) => {
      const i = sentences.findIndex((s) => /100 M€|100 millions/.test(s));
      return i < 0 ? [] : [{ player: "Bouaddi", fromClub: "Lille", toClub: "Manchester City", feeText: "100 M€", feeKind: "transfert", stance: "officiel", sentence: i }];
    });

    const report = await runSource(createMaxifoot(http), extractor, { sleep: noSleep });

    const claim = report.outcomes.flatMap((o) => o.claims).find((c) => c.player === "Bouaddi");
    assert.ok(claim, "déclaration non retenue");
    assert.equal(claim.feeLabel, "100 M€");
    assert.equal(claim.fromClub?.name, "LOSC Lille");
    assert.match(claim.quote, /100 M€|100 millions/);
  });

  it("rejette un montant inventé, sans perdre le reste du passage", async () => {
    const http = fixtureFetcher();
    // Sur chaque article, deux déclarations sur un joueur réellement nommé :
    // l'une avec un montant absent du texte, l'autre sans montant. Seule la
    // première doit tomber — un rejet ne fait pas perdre le reste du lot.
    const extractor = fakeExtractor((sentences) => {
      const player = playerOf(sentences);
      if (!player) return [];
      // Les deux portent un club de L1 : sans lui elles sortiraient du
      // périmètre, et le test mesurerait autre chose que le rejet.
      return [
        { player, fromClub: "PSG", feeText: "12,3 M€", stance: "rumeur", sentence: 0 },
        { player, fromClub: "PSG", stance: "rumeur", sentence: 0 },
      ];
    });

    const report = await runSource(createMaxifoot(http), extractor, { sleep: noSleep });

    assert.ok(report.rejected > 0, "le montant inventé est passé");
    assert.ok(report.claims > 0, "le rejet a emporté la déclaration saine");
    assert.ok(rejectionRate(report) > 0 && rejectionRate(report) < 1);
  });

  it("compte à part une déclaration juste mais hors périmètre", async () => {
    // Une brève L1 qui évoque un deal entre deux clubs étrangers : l'extraction
    // est bonne, elle ne nous concerne pas. La mélanger aux rejets fausserait
    // le seul chiffre qui mesure le modèle.
    const http = fixtureFetcher();
    const extractor = fakeExtractor((sentences) => {
      const player = playerOf(sentences);
      return player ? [{ player, fromClub: "Chelsea", toClub: "Nottingham", stance: "rumeur", sentence: 0 }] : [];
    });

    const report = await runSource(createMaxifoot(http), extractor, { sleep: noSleep });

    assert.ok(report.outOfScope > 0);
    assert.equal(report.claims, 0, "une déclaration hors périmètre a été retenue");
    assert.equal(report.rejected, 0, "hors périmètre compté comme rejet");
  });

  it("survit à un article injoignable", async () => {
    const http: BytesFetcher = {
      async get(url) {
        if (url.includes("rss")) return fixture("maxifoot-rss.xml");
        throw new Error("HTTP 503");
      },
    };

    const report = await runSource(createMaxifoot(http), fakeExtractor(() => []), { sleep: noSleep });

    assert.equal(report.fetched, 0);
    assert.ok(report.errors.length > 0);
    assert.ok(report.errors.length <= 5, "journal d'erreurs non plafonné");
  });

  it("plafonne le lot, parce que c'est le temps CPU qui contraint", async () => {
    const http = fixtureFetcher();
    const extractor = fakeExtractor(() => []);

    await runSource(createMaxifoot(http), extractor, { sleep: noSleep, limit: 2 });

    // Le flux RSS plus au plus deux articles.
    assert.ok(http.calls.length <= 3, `${http.calls.length} requêtes`);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("documente chaque champ que le modèle doit remplir", () => {
    // Le test qui manquait. Deux passages réels ont échoué pour la même
    // raison : un champ présent au schéma mais absent de la consigne. Le
    // modèle rendait alors des déclarations sans aucun club, et une posture
    // tirée au hasard dans une liste de mots français qu'on ne lui avait
    // jamais expliqués.
    //
    // Contrôler la longueur du prompt protégeait la mauvaise chose : son
    // préfixe est mis en cache tant que le modèle reste chargé, donc ces
    // tokens se paient une fois par chargement, pas par article. Ce qui coûte
    // cher, c'est un champ non documenté.
    const required = OLLAMA_FORMAT.properties.claims.items.required;
    for (const field of required) {
      assert.ok(SYSTEM_PROMPT.includes(field), `champ « ${field} » non documenté`);
    }
  });

  it("explique chaque valeur de posture", () => {
    // Une énumération sans glose est un tirage au sort : le modèle a répondu
    // « dementi » sur un transfert officiel tant que les valeurs n'ont pas
    // été définies.
    for (const stance of STANCES) {
      assert.ok(SYSTEM_PROMPT.includes(stance), `posture « ${stance} » non expliquée`);
    }
  });

  it("ne redit pas le schéma en JSON", () => {
    // `format` le contraint déjà au décodage ; le répéter en prose ne ferait
    // que coûter des tokens sans rien garantir de plus.
    assert.ok(!SYSTEM_PROMPT.includes("{"), "schéma répété en prose");
    assert.match(SYSTEM_PROMPT, /RECOPIÉ MOT POUR MOT/);
    // L'absence de montant doit être présentée comme le cas normal : sans ça,
    // un décodeur contraint en fabrique un plutôt que de rendre null.
    assert.match(SYSTEM_PROMPT, /pas un échec/);
  });
});

describe("toPublishPayload", () => {
  /** Le passage réel des fixtures, avec une déclaration retenue sur Bouaddi. */
  const runOnce = () =>
    runSource(
      createMaxifoot(fixtureFetcher()),
      fakeExtractor((sentences) => {
        const i = sentences.findIndex((s) => /100 M€|100 millions/.test(s));
        return i < 0
          ? []
          : [{ player: "Bouaddi", fromClub: "Lille", toClub: "Manchester City", feeText: "100 M€", feeKind: "transfert", stance: "officiel", sentence: i }];
      }),
      { sleep: noSleep },
    );

  it("n'envoie que les articles porteurs d'une déclaration", async () => {
    // Les autres n'enrichissent rien : les envoyer remplirait `press_articles`
    // de brèves muettes, et fausserait le décompte des articles traités.
    const payload = toPublishPayload(await runOnce(), {
      source: "Maxifoot", tier: 1, model: "test", promptVersion: "1",
    });

    assert.equal(payload.articles.length, 1);
    assert.equal(payload.articles[0].claims.length, 1);
    assert.equal(payload.articles[0].claims[0].player, "Bouaddi");
  });

  it("envoie les libellés bruts, jamais les clés résolues", async () => {
    // Le worker rapporte ce qu'il a lu ; c'est le serveur qui décide de quel
    // club il s'agit. Envoyer une clé figerait le référentiel du mini PC.
    const payload = toPublishPayload(await runOnce(), {
      source: "Maxifoot", tier: 1, model: "test", promptVersion: "1",
    });

    const claim = payload.articles[0].claims[0];
    assert.equal(claim.fromClub, "Lille");
    assert.ok(!("fromClubKey" in claim), "une clé de club a fui dans l'envoi");
    assert.equal(claim.feeEur, 100_000_000);
    assert.match(claim.quote, /100 M€|100 millions/);
  });

  it("porte le modèle et la version de consigne au niveau du lot", async () => {
    // Un passage tourne avec un modèle : les répéter par ligne inviterait un
    // worker à envoyer un lot incohérent.
    const payload = toPublishPayload(await runOnce(), {
      source: "Maxifoot", tier: 1, model: "qwen2.5:3b", promptVersion: "4",
    });

    assert.equal(payload.model, "qwen2.5:3b");
    assert.equal(payload.promptVersion, "4");
  });
});

describe("worker -> endpoint", () => {
  it("un passage réel traverse la validation du serveur sans perte", async () => {
    // La couture la plus fragile du pipeline : deux schémas écrits séparément,
    // reliés par du JSON qui traverse le réseau. Un champ renommé d'un côté ne
    // casse rien à la compilation — il vide silencieusement une colonne.
    const report = await runSource(
      createMaxifoot(fixtureFetcher()),
      fakeExtractor((sentences) => {
        const i = sentences.findIndex((s) => /100 M€|100 millions/.test(s));
        return i < 0
          ? []
          : [{ player: "Bouaddi", fromClub: "Lille", toClub: "Manchester City", feeText: "100 M€", feeKind: "transfert", stance: "officiel", sentence: i }];
      }),
      { sleep: noSleep },
    );

    const written: DeclarationRow[] = [];
    const published = await publishDeclarations(
      toPublishPayload(report, { source: "Maxifoot", tier: 1, model: "test", promptVersion: "1" }),
      {
        async upsertArticles(rows) {
          return new Map(rows.map((r) => [r.guid, `id-${r.guid}`]));
        },
        async upsertDeclarations(rows) {
          written.push(...rows);
        },
      },
    );

    assert.equal(published.declarations, 1);
    assert.equal(written[0].player_name, "Bouaddi");
    assert.equal(written[0].fee_eur, 100_000_000);
    // Le club résolu par le serveur, à partir du seul libellé « Lille ».
    assert.equal(written[0].from_club_key, "1082");
    assert.match(written[0].quote, /100 M€|100 millions/);
  });
});

describe("régressions du passage réel du 27/08", () => {
  /** Les phrases d'une brève enregistrée, telles que le modèle les reçoit. */
  async function sentencesOf(file: string) {
    const source = createMaxifoot({ async get(url) { return fixture(url); } });
    const article = await source.fetchArticle({
      guid: file, url: file, title: "", teaser: null, publishedAt: null,
    });
    return prefilter(article).sentences;
  }

  // Les deux sorties EXACTES du modèle ce jour-là. Toutes deux justes, toutes
  // deux rejetées : le modèle normalise la notation du montant vers celle du
  // titre, et la comparaison était littérale.
  it("accepte Fofana, qui écrivait « 40 millions d'euros » pour « 40 M€ »", async () => {
    const sentences = await sentencesOf("maxifoot-article-3.html");
    const v = acceptClaim(
      { player: "Malick Fofana", fromClub: "Olympique Lyonnais", toClub: null, feeText: "40 millions d'euros", feeKind: "transfert", stance: "accord", sentence: 3, feeSentence: 3 },
      sentences,
    );
    assert.ok(v.ok, "extraction juste toujours rejetée");
    assert.equal(v.claim.feeEur, 40_000_000);
    assert.match(v.claim.feeQuote ?? "", /réclame 40 M€/);
  });

  it("accepte Ekomié, qui écrivait « 9,3 M€ » pour « 9,3 millions d'euros »", async () => {
    const sentences = await sentencesOf("maxifoot-article-4.html");
    const v = acceptClaim(
      { player: "Jacques Ekomié", fromClub: "Angers", toClub: "Wrexham", feeText: "9,3 M€", feeKind: "transfert", stance: "accord", sentence: 0, feeSentence: 2 },
      sentences,
    );
    assert.ok(v.ok, "extraction juste toujours rejetée");
    assert.equal(v.claim.feeEur, 9_300_000);
    // Le corps, pas le titre — et une phrase, pas deux.
    assert.match(v.claim.feeQuote ?? "", /^Selon les informations/);
    assert.ok(!/De son côté/.test(v.claim.feeQuote ?? ""), "deux phrases collées en une citation");
  });

  it("rejette toujours un montant que l'article ne porte pas", async () => {
    // Le contrôle qui compte survit au changement : un chiffre plausible et
    // introuvable reste introuvable, où qu'on le cherche.
    const sentences = await sentencesOf("maxifoot-article-3.html");
    const v = acceptClaim(
      { player: "Malick Fofana", fromClub: "Olympique Lyonnais", toClub: null, feeText: "65 M€", feeKind: "transfert", stance: "accord", sentence: 3, feeSentence: 3 },
      sentences,
    );
    assert.equal(v.ok, false);
  });
});

describe("le silence du modèle", () => {
  it("compte à part un article dont le modèle ne tire rien", async () => {
    // Le cadran qui manquait. Sur le passage réel, une signature libre à Brest
    // est passée sans laisser de trace : ni déclaration, ni rejet, et donc
    // aucun effet sur le taux de rejet. Un oubli ne doit pas être invisible.
    const report = await runSource(
      createMaxifoot(fixtureFetcher()),
      fakeExtractor(() => []),
      { sleep: noSleep },
    );

    assert.ok(report.extracted > 0);
    assert.equal(report.silent, report.extracted, "les silences ne sont pas comptés");
    assert.equal(rejectionRate(report), 0, "le taux de rejet ignore les silences — c'est voulu");
  });
});
