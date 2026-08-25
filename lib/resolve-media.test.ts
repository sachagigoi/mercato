import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { resolveMedia, type DailyBudget, type MediaQueue, type PendingMedia } from "./resolve-media.ts";
import type { ApiFootballHit, ApiFootballHttp } from "./sources/apifootball.ts";

/** Dépôt en mémoire : mêmes garanties que la vraie table pour ce que le résolveur observe. */
class FakeQueue implements MediaQueue {
  pending: PendingMedia[];
  resolved: { kind: string; name: string; hit: ApiFootballHit }[] = [];
  missed: { kind: string; name: string }[] = [];

  constructor(pending: PendingMedia[]) {
    this.pending = pending;
  }

  async listPending(limit: number) {
    return this.pending.slice(0, limit);
  }
  async markResolved(kind: "club" | "player", name: string, hit: ApiFootballHit) {
    this.resolved.push({ kind, name, hit });
  }
  async markMissed(kind: "club" | "player", name: string) {
    this.missed.push({ kind, name });
  }
}

/** Reproduit l'UPSERT conditionnel réel : un compteur qui refuse au-delà d'un plafond. */
class FakeBudget implements DailyBudget {
  calls = 0;
  cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  async tryConsumeOne() {
    if (this.calls >= this.cap) return false;
    this.calls += 1;
    return true;
  }
}

/** Rejoue des réponses enregistrées ; aucun accès réseau. */
class FakeHttp implements ApiFootballHttp {
  calls: string[] = [];
  responses: Map<string, unknown>;
  constructor(responses: Map<string, unknown>) {
    this.responses = responses;
  }
  async get(path: string) {
    this.calls.push(path);
    return this.responses.get(path) ?? { response: [] };
  }
}

const item = (over: Partial<PendingMedia> & { kind: PendingMedia["kind"] }): PendingMedia => ({
  name_normalized: "defaut",
  display_name: "Défaut",
  ...over,
});

describe("resolveMedia", () => {
  it("résout un club trouvé et journalise un joueur introuvable", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "psg", display_name: "Paris Saint-Germain" }),
      item({ kind: "player", name_normalized: "joueur inconnu", display_name: "Joueur Inconnu" }),
    ]);
    const http = new FakeHttp(
      new Map([
        [
          "/teams?search=Paris%20Saint-Germain",
          { response: [{ team: { id: 85, logo: "https://cdn/psg.png" } }] },
        ],
        ["/players/profiles?search=Joueur%20Inconnu", { response: [] }],
      ]),
    );

    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http });

    assert.deepEqual(report, { attempted: 2, resolved: 1, missed: 1, budgetExhausted: false });
    assert.deepEqual(queue.resolved, [{ kind: "club", name: "psg", hit: { af_id: 85, image_url: "https://cdn/psg.png" } }]);
    assert.deepEqual(queue.missed, [{ kind: "player", name: "joueur inconnu" }]);
  });

  it("interroge avec le nom d'affichage, jamais le nom normalisé", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "atletico madrid", display_name: "Atlético Madrid" }),
    ]);
    const http = new FakeHttp(new Map());

    await resolveMedia({ queue, budget: new FakeBudget(80), http });

    assert.deepEqual(http.calls, ["/teams?search=Atl%C3%A9tico%20Madrid"]);
  });

  it("s'arrête net dès que le budget est épuisé, sans consommer les suivants", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "a", display_name: "A" }),
      item({ kind: "club", name_normalized: "b", display_name: "B" }),
      item({ kind: "club", name_normalized: "c", display_name: "C" }),
    ]);
    const http = new FakeHttp(new Map());
    const budget = new FakeBudget(1);

    const report = await resolveMedia({ queue, budget, http });

    assert.equal(report.attempted, 1);
    assert.equal(report.budgetExhausted, true);
    assert.equal(budget.calls, 1, "le budget ne doit pas être consommé au-delà du plafond");
    assert.equal(http.calls.length, 1, "aucun appel HTTP pour les lignes non traitées");
  });

  it("respecte batchSize indépendamment de la taille de la file", async () => {
    const queue = new FakeQueue(
      Array.from({ length: 100 }, (_, i) => item({ kind: "club", name_normalized: `c${i}`, display_name: `C${i}` })),
    );
    const http = new FakeHttp(new Map());

    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http }, { batchSize: 10 });

    assert.equal(report.attempted, 10);
  });

  it("ne fait aucun appel réseau sur une file vide", async () => {
    const queue = new FakeQueue([]);
    const http = new FakeHttp(new Map());
    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http });

    assert.deepEqual(report, { attempted: 0, resolved: 0, missed: 0, budgetExhausted: false });
    assert.equal(http.calls.length, 0);
  });
});
