import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ParsedMarketValue } from "./format.ts";
import {
  resolveMarketValues,
  STALE_AFTER_DAYS,
  type MarketValueQueue,
  type PendingValue,
} from "./market-value.ts";
import { profileUrl, type HtmlFetcher } from "./sources/transfermarkt.ts";

const page = (value: string) =>
  `<div class="data-header__market-value-wrapper"><span class="waehrung">€</span>${value}
     <p class="data-header__last-update">Last update: 22/07/2026</p></div>`;

/** File en mémoire : la résolution se teste entièrement sans base ni réseau. */
function fakeQueue(pending: PendingValue[]) {
  const applied = new Map<string, ParsedMarketValue>();
  const missed: string[] = [];
  const queue: MarketValueQueue = {
    async listStale(limit) {
      return pending.slice(0, limit);
    },
    async apply(id, value) {
      applied.set(id, value);
    },
    async markMissed(id) {
      missed.push(id);
    },
  };
  return { queue, applied, missed };
}

function fakeHttp(pages: Record<string, string | Error>) {
  const asked: string[] = [];
  const http: HtmlFetcher = {
    async get(url) {
      asked.push(url);
      const page = pages[url];
      if (page instanceof Error) throw page;
      if (page === undefined) throw new Error(`page non prévue : ${url}`);
      return page;
    },
  };
  return { http, asked };
}

const noSleep = async () => {};

describe("resolveMarketValues", () => {
  it("écrit la valeur lue sur la fiche", async () => {
    const { queue, applied } = fakeQueue([{ tm_player_id: "418560", player_name: "Haaland" }]);
    const { http, asked } = fakeHttp({ [profileUrl("418560")]: page("220.00m") });

    const report = await resolveMarketValues({ queue, http, sleep: noSleep });

    assert.deepEqual(report, { attempted: 1, resolved: 1, missed: 0, errors: [] });
    assert.deepEqual(applied.get("418560"), {
      market_value_eur: 220_000_000,
      market_value_label: "220 M€",
    });
    assert.deepEqual(asked, [profileUrl("418560")]);
  });

  it("horodate la tentative quand la fiche n'a pas d'estimation", async () => {
    // Sans cet horodatage, un joueur non estimé reviendrait en tête de file à
    // chaque passage et occuperait une place pour rien, indéfiniment.
    const { queue, applied, missed } = fakeQueue([{ tm_player_id: "1", player_name: "Inconnu" }]);
    const { http } = fakeHttp({ [profileUrl("1")]: page("-") });

    const report = await resolveMarketValues({ queue, http, sleep: noSleep });

    assert.equal(report.missed, 1);
    assert.equal(applied.size, 0);
    assert.deepEqual(missed, ["1"]);
  });

  it("ne condamne pas une fiche injoignable", async () => {
    // Un incident réseau n'est pas un joueur sans valeur : la ligne doit
    // repartir en tête de file au passage suivant, donc rester non horodatée.
    const { queue, missed } = fakeQueue([{ tm_player_id: "1", player_name: "Coupé" }]);
    const { http } = fakeHttp({ [profileUrl("1")]: new Error("HTTP 503") });

    const report = await resolveMarketValues({ queue, http, sleep: noSleep });

    assert.equal(report.missed, 1);
    assert.deepEqual(missed, []);
    assert.deepEqual(report.errors, ["Coupé : HTTP 503"]);
  });

  it("s'arrête après trois échecs d'affilée plutôt que de brûler le temps de la route", async () => {
    const players = Array.from({ length: 8 }, (_, i) => ({
      tm_player_id: String(i),
      player_name: `J${i}`,
    }));
    const { queue } = fakeQueue(players);
    const { http, asked } = fakeHttp(
      Object.fromEntries(players.map((p) => [profileUrl(p.tm_player_id), new Error("HTTP 503")])),
    );

    const report = await resolveMarketValues({ queue, http, sleep: noSleep });

    assert.equal(report.attempted, 3);
    assert.equal(asked.length, 3);
  });

  it("repart après un échec isolé, sans traiter la source comme perdue", async () => {
    const { queue, applied } = fakeQueue([
      { tm_player_id: "1", player_name: "Un" },
      { tm_player_id: "2", player_name: "Deux" },
      { tm_player_id: "3", player_name: "Trois" },
      { tm_player_id: "4", player_name: "Quatre" },
    ]);
    const { http } = fakeHttp({
      [profileUrl("1")]: new Error("HTTP 503"),
      [profileUrl("2")]: page("10.00m"),
      [profileUrl("3")]: new Error("HTTP 503"),
      [profileUrl("4")]: page("5.00m"),
    });

    const report = await resolveMarketValues({ queue, http, sleep: noSleep });

    assert.equal(report.attempted, 4);
    assert.equal(report.resolved, 2);
    assert.deepEqual([...applied.keys()], ["2", "4"]);
  });

  it("ne demande une fiche qu'une fois par joueur, pas une fois par rumeur", async () => {
    // La file rend des joueurs, pas des lignes : c'est ce qui borne le coût
    // d'un joueur cité dans plusieurs rumeurs à une seule requête.
    let askedLimit = -1;
    const queue: MarketValueQueue = {
      async listStale(limit) {
        askedLimit = limit;
        return [{ tm_player_id: "7", player_name: "Sept" }];
      },
      async apply() {},
      async markMissed() {},
    };
    const { http, asked } = fakeHttp({ [profileUrl("7")]: page("1.00m") });

    await resolveMarketValues({ queue, http, sleep: noSleep }, { batchSize: 4 });

    assert.equal(askedLimit, 4);
    assert.deepEqual(asked, [profileUrl("7")]);
  });

  it("calcule la borne de péremption depuis l'horloge injectée", async () => {
    let seen: Date | undefined;
    const queue: MarketValueQueue = {
      async listStale(_limit, staleBefore) {
        seen = staleBefore;
        return [];
      },
      async apply() {},
      async markMissed() {},
    };
    const now = new Date("2026-08-25T12:00:00.000Z");

    await resolveMarketValues({ queue, http: fakeHttp({}).http, now: () => now });

    const expected = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1_000);
    assert.equal(seen?.toISOString(), expected.toISOString());
  });
});
