import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptClaim, inScope, OLLAMA_FORMAT, type RawClaim } from "./claims.ts";
import { splitSentences } from "./prefilter.ts";

const ARTICLE = splitSentences(
  "PSG : Liverpool optimiste pour Barcola. " +
    "Liverpool et le Paris Saint-Germain ont tenu des discussions pour clarifier la situation " +
    "autour d'un éventuel transfert de l'ailier Bradley Barcola (23 ans). " +
    "Les Reds seraient prêts à mettre 70 M€ sur la table pour l'international français. " +
    "Une affaire à suivre avec attention.",
);

const claim = (over: Partial<RawClaim> = {}): RawClaim => ({
  player: "Bradley Barcola",
  fromClub: "Paris Saint-Germain",
  toClub: "Liverpool",
  feeEur: 70_000_000,
  feeKind: "transfert",
  stance: "discussions",
  sentence: 2,
  ...over,
});

describe("acceptClaim", () => {
  it("accepte une déclaration adossée à sa phrase", () => {
    const v = acceptClaim(claim(), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeEur, 70_000_000);
    assert.equal(v.claim.feeLabel, "70 M€");
    assert.equal(v.claim.fromClub?.name, "Paris Saint-Germain");
    // Le club étranger n'est pas dans le référentiel L1 : on garde son libellé
    // brut plutôt que de perdre l'information.
    assert.equal(v.claim.toClub, null);
    assert.equal(v.claim.toClubRaw, "Liverpool");
  });

  it("rend une citation exacte, reprise du texte et non du modèle", () => {
    const v = acceptClaim(claim(), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.quote, ARTICLE[2]);
    assert.ok(ARTICLE.includes(v.claim.quote), "citation absente du texte");
  });

  it("rejette un montant absent de la phrase désignée", () => {
    // L'hallucination qui coûte le plus cher : un chiffre plausible, bien
    // formé, et introuvable dans l'article. C'est ce contrôle qui rend un
    // modèle local acceptable pour afficher de l'argent.
    const v = acceptClaim(claim({ feeEur: 85_000_000 }), ARTICLE);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.rejected.reason.includes("montant"));
  });

  it("rejette un montant pris dans une autre phrase que celle citée", () => {
    // Le montant est bien dans l'article, mais pas là où le modèle le dit :
    // vérifier au niveau de l'article laisserait passer ce recollage.
    const v = acceptClaim(claim({ sentence: 3 }), ARTICLE);
    assert.equal(v.ok, false);
  });

  it("rejette un joueur absent de l'article", () => {
    const v = acceptClaim(claim({ player: "Kylian Mbappé" }), ARTICLE);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.rejected.reason.includes("joueur"));
  });

  it("accepte le nom hors de la phrase citée, et le signale", () => {
    // Le cas réel qui a fait revoir le garde-fou : la phrase du montant dit
    // « l'international français », pas « Barcola ». L'extraction est juste ;
    // c'est l'exigence qui était trop dure.
    const v = acceptClaim(claim(), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.playerInQuote, false);
    assert.match(v.claim.quote, /international français/);
  });

  it("marque le cas plus sûr où le nom figure dans la citation", () => {
    const v = acceptClaim(claim({ feeEur: null, sentence: 1 }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.playerInQuote, true);
  });

  it("rejette une phrase hors du texte", () => {
    const v = acceptClaim(claim({ sentence: 99 }), ARTICLE);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.rejected.reason.includes("phrase"));
  });

  it("rejette une sortie hors schéma sans lever d'exception", () => {
    // Un article ne doit jamais faire tomber le lot à cause d'une sortie
    // aberrante : le rejet est une donnée, pas un incident.
    for (const bad of [null, {}, { player: "X" }, { player: "Barcola", sentence: -1 }]) {
      const v = acceptClaim(bad, ARTICLE);
      assert.equal(v.ok, false, JSON.stringify(bad));
    }
  });

  it("accepte une déclaration sans montant", () => {
    // Un club qui se positionne fait vivre une piste même sans chiffre.
    const v = acceptClaim(claim({ feeEur: null, sentence: 1, feeKind: "inconnu" }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeEur, null);
    assert.equal(v.claim.feeLabel, null);
  });

  it("tolère un nom partiel, comme la presse l'écrit", () => {
    // Les brèves nomment « Barcola » après l'avoir présenté une fois en entier.
    const v = acceptClaim(claim({ player: "Barcola" }), ARTICLE);
    assert.ok(v.ok);
  });
});

describe("inScope", () => {
  const accepted = (over: Partial<RawClaim>) => {
    const v = acceptClaim(claim(over), ARTICLE);
    assert.ok(v.ok);
    return v.claim;
  };

  it("retient un transfert dont un seul côté est en Ligue 1", () => {
    assert.equal(inScope(accepted({})), true);
  });

  it("écarte un transfert entre deux clubs étrangers", () => {
    // Une brève L1 qui évoque au passage un deal Chelsea -> Nottingham produit
    // une déclaration valide mais hors périmètre.
    assert.equal(
      inScope(accepted({ fromClub: "Chelsea", toClub: "Nottingham Forest" })),
      false,
    );
  });
});

describe("OLLAMA_FORMAT", () => {
  it("ferme les vocabulaires que le modèle pourrait inventer", () => {
    const item = OLLAMA_FORMAT.properties.claims.items.properties;
    assert.ok(item.feeKind.enum.includes("pret_avec_option"));
    assert.ok(item.stance.enum.includes("dementi"));
    // `sentence` est un entier, pas la citation : c'est ce qui économise une
    // quarantaine de tokens par déclaration sur un CPU à 3 tokens/s.
    assert.equal(item.sentence.type, "integer");
  });
});
