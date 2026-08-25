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
  ...over,
});

/** Neutralise l'étalement anti-rate-limit : les tests ne doivent rien attendre. */
const noSleep = async () => {};

describe("resolveMedia", () => {
  it("résout un club trouvé et journalise un joueur introuvable", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "paris saint germain" }),
      item({ kind: "player", name_normalized: "joueur inconnu" }),
    ]);
    const http = new FakeHttp(
      new Map([
        [
          "/teams?search=paris%20saint%20germain",
          { response: [{ team: { id: 85, logo: "https://cdn/psg.png" } }] },
        ],
        ["/players/profiles?search=joueur%20inconnu", { response: [] }],
      ]),
    );

    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http, sleep: noSleep });

    assert.deepEqual(report, { attempted: 2, resolved: 1, missed: 1, budgetExhausted: false });
    assert.deepEqual(queue.resolved, [
      { kind: "club", name: "paris saint germain", hit: { af_id: 85, image_url: "https://cdn/psg.png" } },
    ]);
    assert.deepEqual(queue.missed, [{ kind: "player", name: "joueur inconnu" }]);
  });

  it("interroge avec le nom normalisé, seule forme qu'API-Football accepte", async () => {
    // Contrainte vérifiée contre le vrai service : « Atlético Madrid » est
    // rejeté (`may only contain alpha-numeric characters and spaces`), là où
    // « atletico madrid » renvoie bien le club. Ni accent, ni tiret, ni casse.
    const queue = new FakeQueue([item({ kind: "club", name_normalized: "atletico madrid" })]);
    const http = new FakeHttp(new Map());

    await resolveMedia({ queue, budget: new FakeBudget(80), http, sleep: noSleep });

    assert.deepEqual(http.calls, ["/teams?search=atletico%20madrid"]);
    const [call] = http.calls;
    assert.ok(!/%C3|%E9|-/.test(call), "aucun accent ni tiret ne doit atteindre l'API");
  });

  it("étale les appels pour respecter la limite de 10 requêtes par minute", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "a" }),
      item({ kind: "club", name_normalized: "b" }),
      item({ kind: "club", name_normalized: "c" }),
    ]);
    const waits: number[] = [];

    await resolveMedia(
      {
        queue,
        budget: new FakeBudget(80),
        http: new FakeHttp(new Map()),
        sleep: async (ms) => void waits.push(ms),
      },
      { spacingMs: 6_500 },
    );

    // Une attente entre chaque appel, aucune avant le premier.
    assert.deepEqual(waits, [6_500, 6_500]);
  });

  it("s'arrête net dès que le budget est épuisé, sans consommer les suivants", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "a" }),
      item({ kind: "club", name_normalized: "b" }),
      item({ kind: "club", name_normalized: "c" }),
    ]);
    const http = new FakeHttp(new Map());
    const budget = new FakeBudget(1);

    const report = await resolveMedia({ queue, budget, http, sleep: noSleep });

    assert.equal(report.attempted, 1);
    assert.equal(report.budgetExhausted, true);
    assert.equal(budget.calls, 1, "le budget ne doit pas être consommé au-delà du plafond");
    assert.equal(http.calls.length, 1, "aucun appel HTTP pour les lignes non traitées");
  });

  it("respecte batchSize indépendamment de la taille de la file", async () => {
    const queue = new FakeQueue(
      Array.from({ length: 100 }, (_, i) => item({ kind: "club", name_normalized: `c${i}` })),
    );
    const http = new FakeHttp(new Map());

    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http, sleep: noSleep }, { batchSize: 10 });

    assert.equal(report.attempted, 10);
  });

  it("ne fait aucun appel réseau sur une file vide", async () => {
    const queue = new FakeQueue([]);
    const http = new FakeHttp(new Map());
    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http, sleep: noSleep });

    assert.deepEqual(report, { attempted: 0, resolved: 0, missed: 0, budgetExhausted: false });
    assert.equal(http.calls.length, 0);
  });
});

describe("erreur d'accès API", () => {
  it("s'arrête net sans pénaliser la file", async () => {
    const queue = new FakeQueue([
      item({ kind: "club", name_normalized: "chelsea fc" }),
      item({ kind: "club", name_normalized: "arsenal fc" }),
      item({ kind: "club", name_normalized: "sl benfica" }),
    ]);
    const suspended = {
      errors: { access: "Your account is suspended, check on https://dashboard.api-football.com." },
      response: [],
    };
    const http: ApiFootballHttp = { get: async () => suspended };

    const report = await resolveMedia({ queue, budget: new FakeBudget(80), http, sleep: noSleep });

    assert.equal(report.attempted, 1, "on cesse dès la première réponse inexploitable");
    assert.match(String(report.accessError), /suspended/);
    // Le point qui compte : aucune ligne ne doit être marquée en échec, sinon
    // trois passages sur un compte suspendu les excluraient définitivement.
    assert.deepEqual(queue.missed, []);
    assert.deepEqual(queue.resolved, []);
  });
});
