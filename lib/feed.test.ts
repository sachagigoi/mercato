import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ROWS, maxCreatedAt, mergeRows } from "./feed.ts";
import { FILTERS, filterOf, isFilterKey } from "./filters.ts";

type Row = Parameters<typeof mergeRows>[0][number];

/** Ligne minimale : seuls les champs dont la fusion et les filtres dépendent. */
function row(over: Partial<Row> & { id: string }): Row {
  const t = "2026-08-20T12:00:00+00:00";
  return {
    id: over.id,
    external_id: `ext:${over.id}`,
    player_name: `Joueur ${over.id}`,
    player_photo: null,
    player_cutout: null,
    nationality_code: null,
    from_club_name: null,
    from_club_logo: null,
    to_club_name: null,
    to_club_logo: null,
    transfer_fee: null,
    fee_value_eur: null,
    type: "RUMOUR",
    probability_score: null,
    previous_probability: null,
    status_badge: null,
    source: null,
    source_url: null,
    is_published: true,
    published_at: t,
    created_at: t,
    updated_at: t,
    ...over,
  } as Row;
}

const at = (iso: string) => ({ published_at: iso, created_at: iso });

describe("mergeRows", () => {
  it("dédoublonne sur id — un événement Realtime rejoué n'ajoute pas de carte", () => {
    const a = row({ id: "a" });
    const out = mergeRows([a], [a, a]);
    assert.equal(out.length, 1);
  });

  it("remplace en place plutôt que d'empiler — cas d'un UPDATE de probabilité", () => {
    const before = row({ id: "a", probability_score: 45 });
    const after = row({ id: "a", probability_score: 78 });
    const out = mergeRows([before], [after]);
    assert.equal(out.length, 1);
    assert.equal(out[0].probability_score, 78);
  });

  it("trie sur published_at décroissant, pas sur l'ordre d'arrivée", () => {
    const out = mergeRows(
      [row({ id: "vieux", ...at("2026-08-01T00:00:00+00:00") })],
      [
        row({ id: "recent", ...at("2026-08-24T00:00:00+00:00") }),
        row({ id: "moyen", ...at("2026-08-10T00:00:00+00:00") }),
      ],
    );
    assert.deepEqual(out.map((r) => r.id), ["recent", "moyen", "vieux"]);
  });

  it("tronque à MAX_ROWS en gardant les plus récentes", () => {
    const many = Array.from({ length: MAX_ROWS + 50 }, (_, i) =>
      row({ id: `r${i}`, ...at(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()) }),
    );
    const out = mergeRows([], many);
    assert.equal(out.length, MAX_ROWS);
    assert.equal(out[0].id, `r${many.length - 1}`); // la plus récente en tête
    assert.ok(!out.some((r) => r.id === "r0")); // la plus ancienne est tombée
  });

  it("retire la ligne visée par un DELETE", () => {
    const out = mergeRows([row({ id: "a" }), row({ id: "b" })], [], "a");
    assert.deepEqual(out.map((r) => r.id), ["b"]);
  });

  it("ne mute pas le tableau d'entrée", () => {
    const prev = [row({ id: "a" })];
    mergeRows(prev, [row({ id: "b" })]);
    assert.equal(prev.length, 1);
  });
});

describe("maxCreatedAt", () => {
  it("renvoie l'époque zéro sur un lot vide — tout est à rattraper", () => {
    assert.equal(Date.parse(maxCreatedAt([])), 0);
  });

  it("retient le created_at le plus récent", () => {
    const out = maxCreatedAt([
      row({ id: "a", created_at: "2026-08-01T00:00:00+00:00" }),
      row({ id: "b", created_at: "2026-08-24T09:30:00+00:00" }),
      row({ id: "c", created_at: "2026-08-12T00:00:00+00:00" }),
    ]);
    assert.equal(out, "2026-08-24T09:30:00+00:00");
  });
});

describe("filtres", () => {
  const hot = filterOf("hot");

  it("« Rumeurs chaudes » s'ouvre à 70 inclus", () => {
    assert.equal(hot.match(row({ id: "a", type: "RUMOUR", probability_score: 70 })), true);
    assert.equal(hot.match(row({ id: "b", type: "RUMOUR", probability_score: 69 })), false);
  });

  it("une probabilité nulle n'est pas chaude", () => {
    assert.equal(hot.match(row({ id: "a", type: "RUMOUR", probability_score: null })), false);
  });

  it("un transfert à 100 n'entre pas dans les rumeurs chaudes", () => {
    assert.equal(hot.match(row({ id: "a", type: "TRANSFER", probability_score: 100 })), false);
  });

  it("chaque type a exactement un filtre dédié", () => {
    assert.equal(filterOf("official").match(row({ id: "a", type: "TRANSFER" })), true);
    assert.equal(filterOf("extension").match(row({ id: "a", type: "EXTENSION" })), true);
    assert.equal(filterOf("all").match(row({ id: "a", type: "RUMOUR" })), true);
  });

  it("les clés de filtre inconnues sont rejetées — l'URL est une entrée utilisateur", () => {
    assert.equal(isFilterKey("hot"), true);
    assert.equal(isFilterKey("../etc/passwd"), false);
    assert.equal(isFilterKey(undefined), false);
    assert.equal(filterOf("nawak" as never).key, FILTERS[0].key); // repli sur « Tous »
  });
});
