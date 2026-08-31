import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  BATCH_SIZE,
  ingest,
  mediaKey,
  nextPreviousProbability,
  type ExistingTransfer,
  type MediaAsset,
  type MediaKey,
  type MediaStore,
  type RawTransferInput,
  type TransferStore,
} from "./ingest.ts";
import type { TransferInsert } from "./types.ts";

type StoredRow = TransferInsert & { created_at: string };

/**
 * Dépôt en mémoire reproduisant les contraintes réelles de Postgres.
 *
 * Deux comportements comptent et sont fidèles :
 *   - ON CONFLICT (external_id) DO UPDATE, donc pas de doublon possible ;
 *   - l'erreur « cannot affect row a second time » quand une même clé apparaît
 *     deux fois dans un seul INSERT. C'est ce qui rend le dédoublonnage de lot
 *     réellement testable au lieu d'être supposé.
 */
class FakeTransferStore implements TransferStore {
  rows = new Map<string, StoredRow>();
  upsertCalls = 0;
  clock = 0;

  async findByExternalIds(externalIds: string[]): Promise<ExistingTransfer[]> {
    return externalIds.flatMap((id) => {
      const row = this.rows.get(id);
      if (!row) return [];
      return [
        {
          external_id: row.external_id,
          probability_score: row.probability_score ?? null,
          previous_probability: row.previous_probability ?? null,
          published_at: row.published_at as string,
        },
      ];
    });
  }

  async upsert(batch: TransferInsert[]): Promise<void> {
    this.upsertCalls += 1;
    assert.ok(batch.length <= BATCH_SIZE, "lot plus gros que BATCH_SIZE");

    const seen = new Set<string>();
    for (const row of batch) {
      if (seen.has(row.external_id)) {
        throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
      }
      seen.add(row.external_id);
    }

    for (const row of batch) {
      const existing = this.rows.get(row.external_id);
      // Les colonnes absentes de la charge ne sont pas touchées — created_at compris.
      this.rows.set(row.external_id, {
        ...existing,
        ...row,
        created_at: existing?.created_at ?? `2026-08-24T10:00:${String(this.clock++).padStart(2, "0")}Z`,
      });
    }
  }
}

class FakeMediaStore implements MediaStore {
  assets = new Map<string, MediaAsset>();
  queued: string[] = [];

  async lookup(keys: MediaKey[]): Promise<Map<string, MediaAsset>> {
    const out = new Map<string, MediaAsset>();
    for (const key of keys) {
      const k = mediaKey(key.kind, key.name);
      const hit = this.assets.get(k);
      if (hit) out.set(k, hit);
    }
    return out;
  }

  async enqueue(keys: MediaKey[]): Promise<void> {
    for (const key of keys) this.queued.push(mediaKey(key.kind, key.name));
  }
}

const raw = (over: Partial<RawTransferInput> & { externalId: string }): RawTransferInput => ({
  playerName: "Joueur Test",
  type: "RUMOUR",
  // Un club de Ligue 1 par défaut : depuis que l'ingestion a une porte de
  // périmètre, une rumeur sans aucun club n'entre plus. Les tests de ce
  // fichier mesurent l'idempotence, la tendance et la normalisation — pas le
  // périmètre, qui a ses propres cas plus bas.
  fromClub: "Olympique Lyonnais",
  ...over,
});

let transfers: FakeTransferStore;
let media: FakeMediaStore;
const stores = () => ({ transfers, media });

beforeEach(() => {
  transfers = new FakeTransferStore();
  media = new FakeMediaStore();
});

describe("idempotence", () => {
  const batch = [
    raw({ externalId: "a", playerName: "Rayan Cherki", fee: "€45.00m", probability: 78 }),
    raw({ externalId: "b", playerName: "Lucas Bergeron", type: "TRANSFER", fee: "€32.00m" }),
    raw({ externalId: "c", playerName: "Matteo Ferrara", type: "EXTENSION", fee: "-" }),
  ];

  it("trois exécutions consécutives ne créent aucun doublon", async () => {
    const first = await ingest(batch, stores());
    const second = await ingest(batch, stores());
    const third = await ingest(batch, stores());

    assert.equal(transfers.rows.size, 3, "le nombre de lignes doit rester stable");
    assert.deepEqual(
      [first.inserted, second.inserted, third.inserted],
      [3, 0, 0],
      "seule la première exécution insère",
    );
    assert.deepEqual([first.updated, second.updated, third.updated], [0, 3, 3]);
  });

  it("un doublon dans le lot est écrasé avant l'upsert, la dernière occurrence gagnant", async () => {
    // Sans dédoublonnage, FakeTransferStore lèverait l'erreur de Postgres.
    const report = await ingest(
      [
        raw({ externalId: "a", probability: 78 }),
        raw({ externalId: "a", probability: 81 }),
      ],
      stores(),
    );

    assert.equal(transfers.rows.size, 1);
    assert.equal(transfers.rows.get("a")?.probability_score, 81);
    assert.equal(report.scanned, 2);
    assert.equal(report.skipped, 1);
  });

  it("ne réécrit pas created_at sur une ligne existante", async () => {
    await ingest(batch, stores());
    const before = transfers.rows.get("a")?.created_at;
    await ingest(batch, stores());
    assert.equal(transfers.rows.get("a")?.created_at, before);
  });
});

describe("tendance de probabilité", () => {
  it("garde le repère tant que la probabilité ne bouge pas", async () => {
    await ingest([raw({ externalId: "a", probability: 45 })], stores());
    assert.equal(transfers.rows.get("a")?.previous_probability, null, "insertion : pas de repère");

    await ingest([raw({ externalId: "a", probability: 78 })], stores());
    assert.equal(transfers.rows.get("a")?.previous_probability, 45, "hausse : repère à 45");

    // Le point sensible : une moisson sans changement ne doit pas effacer la
    // tendance. Sinon la flèche ↑33 disparaît vingt minutes après son apparition.
    await ingest([raw({ externalId: "a", probability: 78 })], stores());
    assert.equal(transfers.rows.get("a")?.previous_probability, 45, "sans changement : repère intact");

    await ingest([raw({ externalId: "a", probability: 90 })], stores());
    assert.equal(transfers.rows.get("a")?.previous_probability, 78);
  });

  it("nextPreviousProbability est une fonction pure du couple (existant, entrant)", () => {
    const existing: ExistingTransfer = {
      external_id: "a",
      probability_score: 60,
      previous_probability: 40,
      published_at: "2026-08-24T00:00:00Z",
    };
    assert.equal(nextPreviousProbability(undefined, 60), null);
    assert.equal(nextPreviousProbability(existing, 60), 40);
    assert.equal(nextPreviousProbability(existing, 75), 60);
    assert.equal(nextPreviousProbability(existing, null), 60);
  });
});

describe("published_at", () => {
  it("ne repousse pas une ligne existante en tête de feed", async () => {
    const now = () => new Date("2026-08-24T08:00:00Z");
    await ingest([raw({ externalId: "a" })], stores(), { now });
    const first = transfers.rows.get("a")?.published_at;

    // Deux heures plus tard, la source ne fournit toujours pas de date.
    await ingest([raw({ externalId: "a" })], stores(), {
      now: () => new Date("2026-08-24T10:00:00Z"),
    });
    assert.equal(transfers.rows.get("a")?.published_at, first);
  });

  it("respecte la date fournie par la source", async () => {
    await ingest([raw({ externalId: "a", publishedAt: "2026-08-20T12:00:00Z" })], stores());
    assert.equal(transfers.rows.get("a")?.published_at, "2026-08-20T12:00:00.000Z");
  });
});

describe("validation", () => {
  it("écarte une ligne invalide sans faire échouer le lot", async () => {
    const report = await ingest(
      [
        raw({ externalId: "bon" }),
        { externalId: "sans-nom", type: "RUMOUR" },
        { externalId: "type-inconnu", playerName: "X", type: "TRANSFERT" },
        raw({ externalId: "bon-2", probability: 300 }),
      ],
      stores(),
    );

    assert.equal(transfers.rows.size, 1);
    assert.equal(report.skipped, 3);
    assert.equal(report.errors.length, 3);
    assert.match(report.errors[0], /playerName/);
  });

  it("un lot vide ne touche pas la base", async () => {
    const report = await ingest([], stores());
    assert.equal(transfers.upsertCalls, 0);
    assert.deepEqual(
      { scanned: report.scanned, inserted: report.inserted, updated: report.updated },
      { scanned: 0, inserted: 0, updated: 0 },
    );
  });
});

describe("normalisation", () => {
  it("francise le montant et en extrait la valeur triable", async () => {
    await ingest(
      [
        raw({ externalId: "chiffre", fee: "€45.00m" }),
        raw({ externalId: "pret", fee: "loan transfer" }),
        raw({ externalId: "libre", fee: "free transfer" }),
        raw({ externalId: "inconnu", fee: "?" }),
      ],
      stores(),
    );

    const fee = (id: string) => [
      transfers.rows.get(id)?.transfer_fee,
      transfers.rows.get(id)?.fee_value_eur,
    ];
    assert.deepEqual(fee("chiffre"), ["45 M€", 45_000_000]);
    assert.deepEqual(fee("pret"), ["Prêt", null]);
    assert.deepEqual(fee("libre"), ["Libre", 0]);
    assert.deepEqual(fee("inconnu"), ["—", null]);
  });

  it("met le code pays en minuscules", async () => {
    await ingest([raw({ externalId: "a", nationalityCode: "FR" })], stores());
    assert.equal(transfers.rows.get("a")?.nationality_code, "fr");
  });
});

describe("visuels", () => {
  it("applique le cache et met les inconnus en file, sans appel réseau", async () => {
    media.assets.set(mediaKey("club", "Paris Saint-Germain"), {
      image_url: "https://cdn/psg.png",
      cutout_url: null,
    });

    const report = await ingest(
      [raw({ externalId: "a", playerName: "Rayan Cherki", toClub: "Paris Saint-Germain" })],
      stores(),
    );

    assert.equal(transfers.rows.get("a")?.to_club_logo, "https://cdn/psg.png");
    assert.equal(transfers.rows.get("a")?.player_photo, null);
    assert.ok(media.queued.includes(mediaKey("player", "Rayan Cherki")));
    assert.ok(!media.queued.includes(mediaKey("club", "Paris Saint-Germain")));
    assert.equal(report.apiCallsUsed, 0, "la Phase 3 ne consomme aucun quota");
  });

  it("réconcilie les variantes d'écriture d'un même club", async () => {
    media.assets.set(mediaKey("club", "atletico madrid"), {
      image_url: "https://cdn/atm.png",
      cutout_url: null,
    });
    await ingest([raw({ externalId: "a", toClub: "Atlético  Madrid" })], stores());
    assert.equal(transfers.rows.get("a")?.to_club_logo, "https://cdn/atm.png");
  });
});

describe("lots", () => {
  it("découpe au-delà de BATCH_SIZE et n'en perd aucune", async () => {
    const many = Array.from({ length: BATCH_SIZE * 2 + 7 }, (_, i) => raw({ externalId: `r${i}` }));
    const report = await ingest(many, stores());

    assert.equal(transfers.rows.size, many.length);
    assert.equal(transfers.upsertCalls, 3);
    assert.equal(report.inserted, many.length);
  });
});

describe("le périmètre Ligue 1, à l'ingestion", () => {
  // Transfermarkt sert une page de rumeurs MONDIALE. Mesuré sur un flux réel :
  // 8 rumeurs sur 85 concernent la L1. Les 77 autres ne coûtaient pas que de la
  // place — chaque ligne entre dans la file des valeurs de marché et dans celle
  // du détourage, qui sont le goulot visible du produit.

  it("écarte une rumeur qui ne touche aucun club de Ligue 1", async () => {
    const report = await ingest(
      [raw({ externalId: "x", fromClub: "SSC Napoli", toClub: "Venezia FC" })],
      stores(),
    );

    assert.equal(report.inserted, 0);
    assert.equal(report.outOfScope, 1);
    assert.equal(transfers.rows.size, 0);
    // Et surtout : rien n'entre dans la file des visuels.
    assert.equal(media.queued.length, 0, "un hors-périmètre ne doit rien mettre en file");
  });

  it("garde une ARRIVÉE en Ligue 1", async () => {
    const report = await ingest(
      [raw({ externalId: "x", fromClub: "Bayer 04 Leverkusen", toClub: "Stade Rennais FC" })],
      stores(),
    );
    assert.equal(report.inserted, 1);
    assert.equal(report.outOfScope, 0);
  });

  it("garde un DÉPART de Ligue 1", async () => {
    // Le cas que la compétition de destination — seul champ de périmètre que le
    // scraper remonte — ne saurait pas attraper. Un départ vers l'étranger est
    // exactement ce qu'un feed mercato français doit montrer.
    const report = await ingest(
      [raw({ externalId: "x", fromClub: "Olympique Marseille", toClub: "Racing Santander" })],
      stores(),
    );
    assert.equal(report.inserted, 1);
    assert.equal(report.outOfScope, 0);
  });

  it("ne prend pas une équipe réserve pour son club premier", async () => {
    // Vu sur le flux réel : « Paris Saint-Germain Espoirs ». Le référentiel ne
    // le résout pas, et c'est le comportement voulu — un feed de première
    // équipe n'a rien à dire d'un mouvement de réserve.
    const report = await ingest(
      [raw({ externalId: "x", fromClub: "Paris Saint-Germain Espoirs", toClub: "Ipswich Town" })],
      stores(),
    );
    assert.equal(report.outOfScope, 1);
  });

  it("distingue le hors-périmètre d'une ligne illisible", async () => {
    // `skipped` dit « la ligne était inutilisable » ; `outOfScope` dit « elle
    // était lisible et ne nous concerne pas ». Les confondre masquerait une
    // source qui change de format derrière un chiffre qu'on s'attend à voir
    // gros.
    const report = await ingest(
      [
        raw({ externalId: "ok", fromClub: "RC Lens", toClub: "Paris Saint-Germain" }),
        raw({ externalId: "loin", fromClub: "SSC Napoli", toClub: "US Lecce" }),
        { externalId: "cassé" },
      ],
      stores(),
    );

    assert.equal(report.inserted, 1);
    assert.equal(report.outOfScope, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.errors.length, 1);
  });
});
