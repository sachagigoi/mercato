import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claimKey,
  publishDeclarations,
  type ArticleRow,
  type DeclarationRow,
  type DeclarationStore,
  type PublishInput,
} from "./declarations.ts";

/** Dépôt en mémoire : le module s'éprouve entièrement sans base ni réseau. */
function fakeStore() {
  const articles: ArticleRow[] = [];
  const declarations: DeclarationRow[] = [];

  const store: DeclarationStore = {
    async upsertArticles(rows) {
      const ids = new Map<string, string>();
      for (const row of rows) {
        const existing = articles.findIndex((a) => a.guid === row.guid);
        if (existing >= 0) articles[existing] = row;
        else articles.push(row);
        ids.set(row.guid, `id-${row.guid}`);
      }
      return ids;
    },
    async upsertDeclarations(rows) {
      for (const row of rows) {
        const existing = declarations.findIndex((d) => d.claim_key === row.claim_key);
        if (existing >= 0) declarations[existing] = row;
        else declarations.push(row);
      }
    },
  };

  return { store, articles, declarations };
}

const payload = (over: Partial<PublishInput> = {}): PublishInput => ({
  model: "qwen2.5:7b-instruct-q4_K_M",
  promptVersion: "4",
  articles: [
    {
      source: "Maxifoot",
      tier: 1,
      guid: "maxifoot-12345",
      url: "https://www.maxifoot.fr/football-transfert-12345.htm",
      title: "PSG : Liverpool optimiste pour Barcola",
      publishedAt: "2026-08-26T09:00:00.000Z",
      claims: [
        {
          player: "Bradley Barcola",
          fromClub: "Paris Saint-Germain",
          toClub: "Liverpool",
          feeEur: 70_000_000,
          feeLabel: "70 M€",
          feeKind: "transfert",
          stance: "discussions",
          quote: "Les Reds seraient prêts à mettre 70 M€ sur la table.",
          playerInQuote: false,
        },
      ],
    },
  ],
  ...over,
});

describe("publishDeclarations", () => {
  it("écrit l'article et sa déclaration", async () => {
    const { store, articles, declarations } = fakeStore();
    const report = await publishDeclarations(payload(), store);

    assert.deepEqual(
      { articles: report.articles, declarations: report.declarations, outOfScope: report.outOfScope },
      { articles: 1, declarations: 1, outOfScope: 0 },
    );
    assert.equal(articles[0].source_tier, 1);
    assert.equal(declarations[0].article_id, "id-maxifoot-12345");
    assert.equal(declarations[0].fee_eur, 70_000_000);
  });

  it("résout les clés de club côté serveur, jamais côté worker", async () => {
    // Le worker rapporte ce qu'il a lu ; c'est le référentiel de Vercel qui
    // décide de quel club il s'agit. Une correction du référentiel s'applique
    // ainsi au prochain envoi, sans toucher au mini PC.
    const { store, declarations } = fakeStore();
    await publishDeclarations(payload(), store);

    assert.equal(declarations[0].from_club_key, "583", "PSG doit être résolu");
    assert.equal(declarations[0].from_club_name, "Paris Saint-Germain");
    // Liverpool n'est pas en L1 : pas de clé, mais le libellé est conservé.
    assert.equal(declarations[0].to_club_key, null);
    assert.equal(declarations[0].to_club_name, "Liverpool");
  });

  it("écarte une déclaration sans club de Ligue 1 sans rien écrire", async () => {
    const { store, declarations } = fakeStore();
    const input = payload();
    input.articles[0].claims[0].fromClub = "Chelsea";
    input.articles[0].claims[0].toClub = "Nottingham Forest";

    const report = await publishDeclarations(input, store);
    assert.equal(report.outOfScope, 1);
    assert.equal(report.declarations, 0);
    assert.equal(declarations.length, 0);
  });

  it("est idempotent : rejouer le même lot n'ajoute rien", async () => {
    // C'est ce qui permet au worker de retenter après une coupure sans tenir
    // d'état : le journal local du mini PC n'a pas à faire foi.
    const { store, declarations } = fakeStore();
    await publishDeclarations(payload(), store);
    await publishDeclarations(payload(), store);

    assert.equal(declarations.length, 1);
  });

  it("garde une ligne distincte par modèle, pour pouvoir les comparer", async () => {
    // Rejouer un corpus avec un autre modèle doit produire une extraction
    // comparable à l'ancienne, pas l'écraser : sans ça, aucun banc d'essai
    // ne peut mesurer un changement de modèle sur de vrais articles.
    const { store, declarations } = fakeStore();
    await publishDeclarations(payload(), store);
    await publishDeclarations(payload({ model: "qwen2.5:3b-instruct-q4_K_M" }), store);

    assert.equal(declarations.length, 2);
  });

  it("replie deux déclarations de même clé dans un lot", async () => {
    // Postgres refuse un ON CONFLICT qui touche deux fois la même ligne dans
    // un même lot : le repli doit avoir lieu avant l'écriture.
    const { store, declarations } = fakeStore();
    const input = payload();
    input.articles[0].claims.push({ ...input.articles[0].claims[0], feeLabel: "72 M€" });

    const report = await publishDeclarations(input, store);
    assert.equal(report.declarations, 1);
    assert.equal(declarations.length, 1);
  });

  it("horodate à la réception une date de publication illisible", async () => {
    // Un flux qui rend une date cassée ne doit pas faire tomber le lot : une
    // brève mal horodatée vaut mieux qu'une brève perdue.
    const { store, articles } = fakeStore();
    const now = new Date("2026-08-26T12:00:00.000Z");
    const input = payload();
    input.articles[0].publishedAt = "pas une date";

    await publishDeclarations(input, store, { now: () => now });
    assert.equal(articles[0].published_at, now.toISOString());
  });

  it("refuse un lot malformé plutôt que d'écrire à moitié", async () => {
    const { store, articles } = fakeStore();
    const input = payload();
    // @ts-expect-error : on éprouve justement ce que le typage interdit.
    input.articles[0].url = "pas-une-url";

    await assert.rejects(() => publishDeclarations(input, store));
    assert.equal(articles.length, 0, "aucune écriture avant validation complète");
  });

  it("accepte un lot vide sans appeler le dépôt", async () => {
    const { store, articles } = fakeStore();
    const report = await publishDeclarations(payload({ articles: [] }), store);
    assert.equal(report.articles, 0);
    assert.equal(articles.length, 0);
  });
});

describe("claimKey", () => {
  it("ignore la casse et les accents du nom", async () => {
    const a = claimKey("g", { player: "Bradley Barcola", fromKey: "583", toKey: null }, "m", "4");
    const b = claimKey("g", { player: "bradley barcola", fromKey: "583", toKey: null }, "m", "4");
    assert.equal(a, b);
  });

  it("distingue deux routes pour le même joueur", async () => {
    // Une brève peut évoquer deux destinations : ce sont deux pistes, pas une.
    const a = claimKey("g", { player: "Barcola", fromKey: "583", toKey: null }, "m", "4");
    const b = claimKey("g", { player: "Barcola", fromKey: "583", toKey: "1082" }, "m", "4");
    assert.notEqual(a, b);
  });
});
