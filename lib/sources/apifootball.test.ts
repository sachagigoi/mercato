import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { searchClub, searchPlayer, type ApiFootballHttp } from "./apifootball.ts";

const httpOf = (response: unknown): ApiFootballHttp => ({ get: async () => response });

describe("searchClub", () => {
  it("extrait id et logo du premier résultat", async () => {
    const hit = await searchClub(
      httpOf({ response: [{ team: { id: 85, logo: "https://cdn/psg.png" } }] }),
      "Paris Saint-Germain",
    );
    assert.deepEqual(hit, { af_id: 85, image_url: "https://cdn/psg.png" });
  });

  it("renvoie null sur une réponse vide", async () => {
    assert.equal(await searchClub(httpOf({ response: [] }), "Inconnu"), null);
  });

  it("renvoie null plutôt que de lever, sur une forme de réponse inattendue", async () => {
    // Un tiers qui change son contrat ne doit jamais interrompre le lot en cours.
    assert.equal(await searchClub(httpOf({ error: "rate limited" }), "X"), null);
    assert.equal(await searchClub(httpOf(null), "X"), null);
    assert.equal(await searchClub(httpOf(undefined), "X"), null);
  });

  it("renvoie null quand le résultat n'a pas de logo", async () => {
    const hit = await searchClub(httpOf({ response: [{ team: { id: 1, logo: null } }] }), "X");
    assert.equal(hit, null);
  });
});

describe("searchPlayer", () => {
  it("extrait id et photo du premier résultat", async () => {
    const hit = await searchPlayer(
      httpOf({ response: [{ player: { id: 418560, photo: "https://cdn/cherki.png" } }] }),
      "Rayan Cherki",
    );
    assert.deepEqual(hit, { af_id: 418560, image_url: "https://cdn/cherki.png" });
  });

  it("renvoie null sur une réponse vide", async () => {
    assert.equal(await searchPlayer(httpOf({ response: [] }), "Inconnu"), null);
  });
});
