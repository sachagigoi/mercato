import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clubInitials,
  flagEmoji,
  formatFee,
  normalizeName,
  parseFee,
  probabilityTrend,
  relativeTime,
} from "./format.ts";

describe("parseFee", () => {
  it("lit les montants chiffrés dans les formats des sources", () => {
    assert.deepEqual(parseFee("€45.00m"), { transfer_fee: "45 M€", fee_value_eur: 45_000_000 });
    assert.deepEqual(parseFee("€850k"), { transfer_fee: "850 k€", fee_value_eur: 850_000 });
    assert.deepEqual(parseFee("€1.50m"), { transfer_fee: "1,5 M€", fee_value_eur: 1_500_000 });
    assert.deepEqual(parseFee("45 M€"), { transfer_fee: "45 M€", fee_value_eur: 45_000_000 });
    assert.deepEqual(parseFee("€1.20bn"), { transfer_fee: "1,2 Md€", fee_value_eur: 1_200_000_000 });
  });

  it("reconnaît un transfert libre en français, anglais et allemand", () => {
    for (const input of ["free transfer", "ablösefrei", "Libre", "bosman"]) {
      assert.deepEqual(parseFee(input), { transfer_fee: "Libre", fee_value_eur: 0 }, input);
    }
  });

  it("reconnaît un prêt, et le prêt l'emporte sur le montant qui l'accompagne", () => {
    for (const input of ["loan transfer", "Leihe", "prêt"]) {
      assert.deepEqual(parseFee(input), { transfer_fee: "Prêt", fee_value_eur: null }, input);
    }
    // Un prêt payant reste un prêt : la carte doit dire « Prêt », pas « 2 M€ ».
    assert.deepEqual(parseFee("loan fee: €2.00m"), { transfer_fee: "Prêt", fee_value_eur: null });
  });

  it("rend un montant inconnu comme absent, jamais comme zéro", () => {
    for (const input of ["?", "-", "—", "", "   ", null, undefined]) {
      const out = parseFee(input);
      assert.equal(out.transfer_fee, "—", JSON.stringify(input));
      assert.equal(out.fee_value_eur, null, JSON.stringify(input));
    }
  });

  it("ne confond pas un texte sans chiffre avec un montant", () => {
    assert.deepEqual(parseFee("draft"), { transfer_fee: "—", fee_value_eur: null });
  });
});

describe("formatFee", () => {
  it("n'affiche pas de décimale inutile", () => {
    assert.equal(formatFee(45_000_000), "45 M€");
    assert.equal(formatFee(1_500_000), "1,5 M€");
    assert.equal(formatFee(850_000), "850 k€");
    assert.equal(formatFee(600), "600 €");
    assert.equal(formatFee(0), "Libre");
  });
});

describe("normalizeName", () => {
  it("réconcilie accents, casse et ponctuation", () => {
    assert.equal(normalizeName("Atlético  Madrid!"), "atletico madrid");
    assert.equal(normalizeName("Borussia Mönchengladbach"), "borussia monchengladbach");
    assert.equal(normalizeName("Saint-Étienne"), "saint etienne");
  });
});

describe("clubInitials", () => {
  it("garde un acronyme déjà constitué au lieu de le réduire", () => {
    assert.equal(clubInitials("PSV Eindhoven"), "PSV");
    assert.equal(clubInitials("AS Monaco"), "ASM");
    assert.equal(clubInitials("OGC Nice"), "OGC");
  });

  it("compose les initiales sinon", () => {
    assert.equal(clubInitials("Paris Saint-Germain"), "PSG");
    assert.equal(clubInitials("Manchester United"), "MU");
    assert.equal(clubInitials("Juventus"), "JUV");
    assert.equal(clubInitials(null), "?");
  });
});

describe("flagEmoji", () => {
  it("convertit un code ISO en drapeau", () => {
    assert.equal(flagEmoji("fr"), "🇫🇷");
    assert.equal(flagEmoji("BR"), "🇧🇷");
  });

  it("renvoie vide sur une entrée qui n'est pas un code pays", () => {
    for (const bad of ["", "f", "fra", "12", null, undefined]) {
      assert.equal(flagEmoji(bad), "", JSON.stringify(bad));
    }
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-24T12:00:00Z");
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);

  it("échelonne les libellés", () => {
    assert.equal(ago(30_000), "à l'instant");
    assert.equal(ago(5 * 60_000), "il y a 5 min");
    assert.equal(ago(3 * 3_600_000), "il y a 3 h");
    assert.equal(ago(26 * 3_600_000), "hier");
    assert.equal(ago(4 * 86_400_000), "il y a 4 j");
  });

  it("passe à la date absolue au-delà d'une semaine", () => {
    assert.match(ago(20 * 86_400_000), /août/);
  });
});

describe("probabilityTrend", () => {
  it("masque les variations illisibles", () => {
    assert.equal(probabilityTrend(72, 70), null, "2 points ne se voient pas sur la jauge");
    assert.deepEqual(probabilityTrend(78, 66), { delta: 12, direction: "up" });
    assert.deepEqual(probabilityTrend(12, 26), { delta: -14, direction: "down" });
  });

  it("ne conclut rien sans repère", () => {
    assert.equal(probabilityTrend(78, null), null);
    assert.equal(probabilityTrend(null, 40), null);
  });
});
