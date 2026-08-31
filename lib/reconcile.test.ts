import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RawTransferInput } from "./ingest.ts";
import {
  canCreate,
  matchTransfer,
  pressExternalId,
  reconcile,
  toRawTransfer,
  type CandidateTransfer,
  type PendingDeclaration,
  type ReconcileStore,
} from "./reconcile.ts";

const declaration = (over: Partial<PendingDeclaration> = {}): PendingDeclaration => ({
  id: "d1",
  playerName: "Igor Paixao",
  playerNormalized: "igor paixao",
  fromClubName: "Olympique de Marseille",
  toClubName: "Sunderland",
  feeEur: 35_000_000,
  feeKind: "transfert",
  qualifier: "environ",
  stance: "discussions",
  publishedAt: "2026-08-27T09:00:00.000Z",
  source: "Maxifoot",
  url: "https://www.maxifoot.fr/om/paixao-foot-462627.htm",
  ...over,
});

const candidate = (over: Partial<CandidateTransfer> = {}): CandidateTransfer => ({
  id: "t1",
  externalId: "tm:rumour:12345:678",
  fromClubName: "Olympique de Marseille",
  toClubName: "Sunderland",
  feeValueEur: null,
  ...over,
});

describe("matchTransfer", () => {
  it("reconnaît la même piste à la destination", () => {
    assert.equal(matchTransfer(declaration(), [candidate()])?.id, "t1");
  });

  it("tolère une autre écriture du même club", () => {
    // Les libellés viennent de deux sources qui ne se parlent pas.
    const v = matchTransfer(declaration({ toClubName: "sunderland" }), [candidate()]);
    assert.equal(v?.id, "t1");
  });

  it("ne fond pas deux destinations différentes", () => {
    // Un joueur courtisé par deux clubs, ce sont deux pistes — exactement ce
    // que le produit doit montrer plutôt que d'aplatir.
    const v = matchTransfer(declaration({ toClubName: "Liverpool" }), [candidate()]);
    assert.equal(v, null);
  });

  it("rejoint une piste dont la destination n'est pas encore nommée", () => {
    // La presse parle d'un départ dont elle ne nomme pas l'arrivée, ou
    // l'inverse : c'est la même piste qui se précise.
    const v = matchTransfer(declaration({ toClubName: null }), [candidate({ toClubName: null })]);
    assert.equal(v?.id, "t1");
  });

  it("ne rapproche rien sur le seul club d'origine quand les deux destinations sont nommées", () => {
    const v = matchTransfer(
      declaration({ toClubName: "Liverpool" }),
      [candidate({ toClubName: "Sunderland" })],
    );
    assert.equal(v, null);
  });

  it("ne rapproche rien sans candidat", () => {
    assert.equal(matchTransfer(declaration(), []), null);
  });
});

describe("canCreate", () => {
  it("refuse de créer une piste sans destination", () => {
    // Une carte « Fofana -> ? » n'apprend rien. La déclaration attend la
    // rumeur Transfermarkt plutôt que d'ouvrir une piste borgne.
    assert.equal(canCreate(declaration({ toClubName: null })), false);
  });

  it("refuse de créer une piste sur un démenti", () => {
    // Faire naître une rumeur d'un article qui affirme qu'elle est fausse.
    assert.equal(canCreate(declaration({ stance: "dementi" })), false);
  });

  it("accepte une piste nommée des deux bouts", () => {
    assert.equal(canCreate(declaration()), true);
  });
});

describe("pressExternalId", () => {
  it("ne dépend pas de la source", () => {
    // Deux journaux qui rapportent le même mouvement doivent produire une
    // piste, pas deux cartes.
    const a = pressExternalId(declaration({ source: "Maxifoot" }));
    const b = pressExternalId(declaration({ source: "Foot Mercato", id: "d2" }));
    assert.equal(a, b);
  });

  it("distingue deux destinations pour le même joueur", () => {
    assert.notEqual(
      pressExternalId(declaration()),
      pressExternalId(declaration({ toClubName: "Liverpool" })),
    );
  });
});

describe("toRawTransfer", () => {
  it("marque officiel comme transfert, le reste comme rumeur", () => {
    assert.equal(toRawTransfer(declaration({ stance: "officiel" })).type, "TRANSFER");
    assert.equal(toRawTransfer(declaration({ stance: "accord" })).type, "RUMOUR");
  });

  it("porte le montant et la provenance", () => {
    const row = toRawTransfer(declaration());
    assert.equal(row.fee, "35 M€");
    assert.equal(row.source, "Maxifoot");
    assert.match(row.sourceUrl ?? "", /maxifoot/);
  });
});

/** Dépôt en mémoire : le rapprochement s'éprouve sans base ni réseau. */
function fakeStore(
  declarations: PendingDeclaration[],
  candidates: Map<string, CandidateTransfer[]> = new Map(),
) {
  const links: Array<[string, string]> = [];
  const fees: Array<[string, number]> = [];
  const created: RawTransferInput[] = [];

  const store: ReconcileStore = {
    async pending(limit) { return declarations.slice(0, limit); },
    async candidates(players) {
      return new Map(players.flatMap((p) => (candidates.has(p) ? [[p, candidates.get(p)!]] : [])));
    },
    async link(declarationId, transferId) { links.push([declarationId, transferId]); },
    async applyFee(transferId, fee) { fees.push([transferId, fee.eur]); },
    async idsByExternalId(ids) { return new Map(ids.map((id) => [id, `new-${id}`])); },
  };

  return {
    store, links, fees, created,
    create: async (rows: RawTransferInput[]) => { created.push(...rows); },
  };
}

describe("reconcile", () => {
  it("rattache et pose le montant qui manquait à la piste", () => {
    // Le cas qui justifie tout le pipeline : Transfermarkt donne la rumeur
    // sans chiffre, la presse donne le chiffre.
    const f = fakeStore([declaration()], new Map([["igor paixao", [candidate()]]]));
    return reconcile(f.store).then((report) => {
      assert.equal(report.linked, 1);
      assert.equal(report.enriched, 1);
      assert.deepEqual(f.links, [["d1", "t1"]]);
      assert.deepEqual(f.fees, [["t1", 35_000_000]]);
    });
  });

  it("n'écrase pas un montant déjà porté par la piste", async () => {
    // Un transfert conclu porte le chiffre officiel : une estimation de presse
    // n'a pas à le remplacer. Le lien est posé quand même — l'observation vaut
    // d'être conservée même quand elle ne change rien à l'affichage.
    const f = fakeStore(
      [declaration()],
      new Map([["igor paixao", [candidate({ feeValueEur: 40_000_000 })]]]),
    );
    const report = await reconcile(f.store);
    assert.equal(report.linked, 1);
    assert.equal(report.enriched, 0);
    assert.equal(f.fees.length, 0);
  });

  it("ouvre une piste quand aucune ne correspond", async () => {
    const f = fakeStore([declaration()]);
    const report = await reconcile(f.store, { create: f.create });

    assert.equal(report.created, 1);
    assert.equal(report.linked, 1);
    assert.equal(f.created[0].playerName, "Igor Paixao");
    assert.deepEqual(f.links, [["d1", `new-${pressExternalId(declaration())}`]]);
  });

  it("laisse en attente ce qu'elle ne sait ni rattacher ni créer", async () => {
    // Fofana : « vente inéluctable, au moins 25 M€ », sans destination nommée.
    const f = fakeStore([declaration({ toClubName: null, id: "d9" })]);
    const report = await reconcile(f.store, { create: f.create });

    assert.equal(report.deferred, 1);
    assert.equal(report.linked, 0);
    assert.equal(f.created.length, 0, "une piste borgne a été créée");
  });

  it("ne crée rien sans fonction de création", async () => {
    const f = fakeStore([declaration()]);
    const report = await reconcile(f.store);
    assert.equal(report.deferred, 1);
    assert.equal(report.created, 0);
  });

  it("ne compte qu'une piste pour deux journaux sur le même mouvement", async () => {
    const f = fakeStore([
      declaration({ id: "d1", source: "Maxifoot" }),
      declaration({ id: "d2", source: "Foot Mercato" }),
    ]);
    const report = await reconcile(f.store, { create: f.create });

    assert.equal(report.created, 1, "deux cartes pour un seul mouvement");
    assert.equal(report.linked, 2, "les deux déclarations doivent pointer la piste");
  });

  it("ne tombe pas sur une erreur d'écriture", async () => {
    const f = fakeStore([declaration()], new Map([["igor paixao", [candidate()]]]));
    f.store.link = async () => { throw new Error("conflit"); };

    const report = await reconcile(f.store);
    assert.equal(report.linked, 0);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /Paixao/);
  });

  it("ne demande rien à la base quand la file est vide", async () => {
    const f = fakeStore([]);
    f.store.candidates = async () => { throw new Error("appel inutile"); };
    const report = await reconcile(f.store);
    assert.equal(report.pending, 0);
  });
});
