import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptClaim, dedupeClaims, inScope, OLLAMA_FORMAT, type RawClaim } from "./claims.ts";
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
  feeText: "70 M€",
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

  it("ne demande jamais au modèle de convertir un montant", () => {
    // « 100 M€ » recopié, pas 100000000 calculé : la multiplication est ce
    // qu'un petit modèle rate le plus souvent, et un parseur testé existe.
    const v = acceptClaim(claim({ feeText: "70 M€" }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeEur, 70_000_000);
  });

  it("tolère les espaces insécables du texte source", () => {
    const v = acceptClaim(claim({ feeText: "70M€" }), ARTICLE);
    assert.ok(v.ok, "recopie sans espace refusée");
  });

  it("rejette un montant absent de l'article", () => {
    // L'hallucination qui coûte le plus cher : un chiffre plausible, bien
    // formé, et introuvable dans l'article. C'est ce contrôle qui rend un
    // modèle local acceptable pour afficher de l'argent — et il survit au
    // passage d'une vérification par phrase à une recherche sur le texte.
    const v = acceptClaim(claim({ feeText: "85 M€" }), ARTICLE);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.rejected.reason.includes("montant"));
  });

  it("retrouve le montant quel que soit l'indice donné par le modèle", () => {
    // Cas réel : sur la brève Ekomié, le montant figurait jusque dans le titre,
    // et le modèle désignait une autre phrase. L'extraction était juste ; c'est
    // le contrôle par phrase qui la rejetait.
    const v = acceptClaim(claim({ sentence: 1, feeSentence: 1 }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeEur, 70_000_000);
    assert.equal(v.claim.quote, ARTICLE[1], "la citation doit rester celle du transfert");
    assert.equal(v.claim.feeQuote, ARTICLE[2], "le montant doit citer la phrase où il est");
  });

  it("accepte une autre notation du même montant", () => {
    // Cas réel : le modèle a rendu « 40 millions d'euros » là où l'article
    // écrivait « 40 M€ ». Même fait, autre écriture — la comparaison porte
    // désormais sur la valeur, avec le même parseur des deux côtés.
    const v = acceptClaim(claim({ feeText: "70 millions d'euros" }), ARTICLE);
    assert.ok(v.ok, "notation équivalente refusée");
    assert.equal(v.claim.feeEur, 70_000_000);
  });

  it("ignore un indice de phrase hors du texte au lieu de rejeter", () => {
    // L'indice ne sert plus qu'à départager : il ne peut plus rien faire
    // tomber. Le modèle pointe mal bien plus souvent qu'il n'invente.
    const v = acceptClaim(claim({ sentence: 1, feeSentence: 99 }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeQuote, ARTICLE[2]);
  });

  it("cite le corps plutôt que le titre quand les deux portent le montant", () => {
    // Un titre résume, il ne rapporte pas. Les trois extractions du dernier
    // passage réel citaient toutes le titre : vrai, mais sans valeur de preuve.
    const withTitle = ["PSG : Liverpool prêt à mettre 70 M€.", ...ARTICLE];
    const v = acceptClaim(claim({ sentence: 0, feeSentence: null }), withTitle);
    assert.ok(v.ok);
    assert.equal(v.claim.feeQuote, withTitle[3], "le titre a été préféré au corps");
  });

  it("retombe sur la phrase du montant quand feeSentence est absent", () => {
    const v = acceptClaim(claim({ feeSentence: null }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeQuote, ARTICLE[2]);
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
    const v = acceptClaim(claim({ feeText: null, sentence: 1 }), ARTICLE);
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

  it("lit la nuance dans le texte, contre l'avis du modèle", () => {
    // Le modèle rend « exact » quoi qu'il arrive — deux passages réels l'ont
    // montré sur « environ 35 M€ » et « au moins 25 M€ ». Le texte, lui, le
    // dit juste avant le chiffre, et le code sait le lire.
    const nuanced = splitSentences(
      "PSG : Liverpool optimiste pour Barcola. " +
        "Un transfert de Bradley Barcola est évoqué. " +
        "Les Reds seraient prêts à mettre environ 70 M€ sur la table.",
    );
    const v = acceptClaim(claim({ qualifier: "exact", sentence: 1 }), nuanced);
    assert.ok(v.ok);
    assert.equal(v.claim.qualifier, "environ");
    assert.equal(v.claim.feeEur, 70_000_000);
  });

  it("garde la valeur du modèle quand le texte ne nuance rien", () => {
    // Repli et non écrasement : le vocabulaire d'un journaliste peut sortir de
    // ce que le code sait lire, et le modèle reste alors la meilleure source.
    const v = acceptClaim(claim({ qualifier: "minimum" }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.qualifier, "minimum");
  });

  it("accepte une déclaration sans montant", () => {
    // Un club qui se positionne fait vivre une piste même sans chiffre.
    const v = acceptClaim(claim({ feeText: null, sentence: 1, feeKind: "inconnu" }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.feeEur, null);
    assert.equal(v.claim.feeLabel, null);
  });

  it("rejette un club de L1 que l'article ne cite pas", () => {
    // Le pendant des contrôles sur le joueur et sur le montant, devenu
    // nécessaire depuis que la consigne pousse le modèle à remplir les clubs.
    // Une piste attribuée au mauvais club est pire qu'une piste manquée.
    const v = acceptClaim(claim({ fromClub: "LOSC Lille" }), ARTICLE);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.rejected.reason.includes("club"));
  });

  it("accepte un club cité sous une autre forme que celle du modèle", () => {
    // La comparaison porte sur l'identifiant, pas sur le libellé : le modèle
    // écrit « PSG » là où l'article écrit « Paris Saint-Germain ».
    const v = acceptClaim(claim({ fromClub: "PSG" }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.fromClub?.tmId, "583");
    assert.equal(v.claim.fromClubRaw, "PSG", "le libellé brut doit être conservé");
  });

  it("laisse passer un club étranger sans le vérifier", () => {
    // Le référentiel ne couvre que la L1 : exiger la citation d'un club qu'il
    // ne connaît pas reviendrait à rejeter tous les transferts sortants.
    const v = acceptClaim(claim({ toClub: "Al Hilal" }), ARTICLE);
    assert.ok(v.ok);
    assert.equal(v.claim.toClubRaw, "Al Hilal");
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
    // `null` est un type légal pour le montant : sans issue pour dire « aucun
    // montant », un décodeur contraint en fabrique un — c'est ce qui a donné
    // 100 % de rejet au premier passage réel.
    assert.ok(item.feeText.type.includes("null"));
    assert.ok(item.stance.enum.includes("dementi"));
    // `sentence` est un entier, pas la citation : c'est ce qui économise une
    // quarantaine de tokens par déclaration sur un CPU à 3 tokens/s.
    assert.equal(item.sentence.type, "integer");
  });
});

describe("dedupeClaims", () => {
  const accepted = (over: Partial<RawClaim>) => {
    const v = acceptClaim(claim(over), ARTICLE);
    assert.ok(v.ok);
    return v.claim;
  };

  it("replie cinq écritures du même transfert en une", () => {
    // Le cas réel : sur la brève Barcola, le 3B a rendu une entrée par phrase
    // du corps. Cinq écritures du même fait, pas cinq faits.
    const five = [0, 1, 2, 3, 4].map((i) => accepted({ feeText: null, sentence: Math.min(i, 3) }));
    const { kept, folded } = dedupeClaims(five);
    assert.equal(kept.length, 1);
    assert.equal(folded, 4);
  });

  it("garde la déclaration chiffrée face à une sans montant", () => {
    // C'est le montant qu'on est venu chercher : entre deux écritures du même
    // transfert, celle qui le porte gagne.
    const { kept } = dedupeClaims([
      accepted({ feeText: null, sentence: 1 }),
      accepted({ feeText: "70 M€" }),
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].feeEur, 70_000_000);
  });

  it("départage ensuite sur le nom présent dans la citation", () => {
    // À valeur égale, la citation qui nomme le joueur se défend mieux.
    const { kept } = dedupeClaims([
      accepted({ feeText: null, sentence: 3 }),
      accepted({ feeText: null, sentence: 1 }),
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].playerInQuote, true);
  });

  it("ne replie pas deux destinations différentes", () => {
    // Deux clubs qui se disputent un joueur, ce sont deux pistes.
    const { kept, folded } = dedupeClaims([
      accepted({ toClub: "Liverpool" }),
      accepted({ toClub: "Chelsea" }),
    ]);
    assert.equal(kept.length, 2);
    assert.equal(folded, 0);
  });
});

describe("messages de rejet", () => {
  it("nomme le champ fautif, pas seulement la contrainte", () => {
    // « Too small: expected string to have >=2 characters » ne dit pas s'il
    // s'agit du joueur ou d'un club. Un passage réel a rendu quatre fois ce
    // message sans qu'on puisse savoir quoi corriger.
    const v = acceptClaim({ ...claim(), player: "" }, ARTICLE);
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.rejected.reason.includes("player"), v.ok ? "" : v.rejected.reason);
  });
});

describe("nature de l'opération", () => {
  it("déclasse un « libre » que l'article n'affirme nulle part", () => {
    // Le cas réel : sur la brève Jonathan David, le modèle a rendu `libre`
    // pour un joueur sous contrat, dans un texte qui n'emploie jamais le mot.
    // `libre` allume une pastille sur la carte — une affirmation sur la
    // situation contractuelle d'une personne.
    const v = acceptClaim(claim({ feeText: null, feeKind: "libre" }), ARTICLE);
    assert.ok(v.ok, "la déclaration ne doit pas être perdue pour un champ");
    assert.equal(v.claim.feeKind, "inconnu");
  });

  it("garde la nature que le texte atteste", () => {
    const libre = splitSentences(
      "PSG : Barcola libre en juin. Bradley Barcola sera libre de tout contrat cet été.",
    );
    const v = acceptClaim(claim({ feeText: null, feeKind: "libre", sentence: 1 }), libre);
    assert.ok(v.ok);
    assert.equal(v.claim.feeKind, "libre");
  });

  it("retombe sur le prêt quand l'option n'est pas dite", () => {
    // Déclasser jusqu'à « inconnu » perdrait ce que le texte dit vraiment.
    const prete = splitSentences(
      "PSG : Barcola en prêt. Bradley Barcola part en prêt du Paris Saint-Germain à Liverpool.",
    );
    const v = acceptClaim(
      claim({ feeText: null, feeKind: "pret_avec_option", sentence: 1 }),
      prete,
    );
    assert.ok(v.ok);
    assert.equal(v.claim.feeKind, "pret");
  });

  it("n'exige rien de « transfert » ni d'« inconnu »", () => {
    // Le premier est le cas par défaut d'un mercato, le second ne prétend rien.
    for (const feeKind of ["transfert", "inconnu"] as const) {
      const v = acceptClaim(claim({ feeKind }), ARTICLE);
      assert.ok(v.ok);
      assert.equal(v.claim.feeKind, feeKind);
    }
  });
});

describe("le rôle d'un club, pas seulement sa présence", () => {
  // Les cinq brèves du passage du 30 août, et ce que qwen2.5:7b en a rendu.
  // Le tableau de bord affichait « 0 rejeté, taux de rejet 0 % » sur un lot qui
  // contenait une carte fausse : il mesurait ce que le garde-fou attrapait, pas
  // ce qui était vrai.

  it("rejette un club prétendant donné pour l'origine", () => {
    // Monaco et la Juventus sont deux PRÉTENDANTS au même joueur. Le modèle en
    // a fait « Monaco -> Juventus » : une carte disant que Sarr quitte un club
    // où il n'a jamais joué. Tous les contrôles d'alors passaient — les deux
    // clubs cités, le joueur cité, « prêt avec option d'achat » littéralement
    // dans le texte.
    const breve = splitSentences(
      "En vue d'un potentiel départ de Lamine Camara, l'AS Monaco pense à recruter " +
        "Pape Matar Sarr (23 ans). Mais le club de la Principauté devra se montrer plus " +
        "convaincant que la Juventus, qui a fait son apparition sur le dossier. La Vieille " +
        "Dame étudie notamment la possibilité de solliciter un prêt avec option d'achat.",
    );
    const v = acceptClaim(
      claim({
        player: "Pape Matar Sarr",
        fromClub: "AS Monaco",
        toClub: "Juventus",
        feeText: null,
        feeKind: "pret_avec_option",
        stance: "rumeur",
        sentence: 0,
      }),
      breve,
    );
    assert.ok(!v.ok);
    assert.match(v.rejected.reason, /rôle contredit/);
  });

  it("laisse passer le silence, qui est le cas courant", () => {
    // Le club est nommé, mais rien entre lui et le joueur ne dit le sens.
    // Exiger que le texte CONFIRME le rôle rejetterait l'essentiel des
    // extractions justes — la presse désigne un club par une périphrase une
    // phrase sur deux (« le club artésien », « la Vieille Dame »). Le contrôle
    // ne rejette que la contradiction.
    const breve = splitSentences(
      "Le RC Lens et West Ham ont trouvé un accord pour Jean-Clair Todibo.",
    );
    const v = acceptClaim(
      claim({
        player: "Jean-Clair Todibo",
        fromClub: "West Ham",
        toClub: "RC Lens",
        feeText: null,
        feeKind: "pret",
        stance: "accord",
        sentence: 0,
      }),
      breve,
    );
    assert.ok(v.ok);
  });

  it("accepte le club qui accueille, dit comme tel", () => {
    const breve = splitSentences(
      "Le RC Strasbourg a trouvé un accord avec le RB Leipzig pour l'arrivée de " +
        "Conrad Harder (21 ans).",
    );
    const v = acceptClaim(
      claim({
        player: "Conrad Harder",
        fromClub: "RB Leipzig",
        toClub: "RC Strasbourg",
        feeText: null,
        feeKind: "pret",
        stance: "accord",
        sentence: 0,
      }),
      breve,
    );
    assert.ok(v.ok);
    assert.equal(v.claim.toClub?.name, "RC Strasbourg");
  });

  it("accepte le club qu'on quitte, dit comme tel", () => {
    const breve = splitSentences(
      "Ange Lago (21 ans) va quitter l'Olympique de Marseille cet été. Le joueur " +
        "sera libéré de son contrat.",
    );
    const v = acceptClaim(
      claim({
        player: "Ange Lago",
        fromClub: "Olympique de Marseille",
        toClub: "Dijon",
        feeText: null,
        feeKind: "libre",
        stance: "officiel",
        sentence: 0,
      }),
      breve,
    );
    assert.ok(v.ok);
    assert.equal(v.claim.fromClub?.name, "Olympique de Marseille");
    // « libéré de son contrat » est la formulation la plus courante de la presse
    // française après « libre », et le texte est désaccentué avant le test :
    // `\blibre\b` ne matche pas « libere ». Deux départs libres réels sont
    // sortis en « inconnu » à cause de ce seul trou.
    assert.equal(v.claim.feeKind, "libre");
  });

  it("ne tranche pas quand les deux sens cohabitent", () => {
    // « départ » est dans la phrase, mais accolé à un AUTRE joueur. On ne lit
    // qu'entre la mention du club et celle du joueur déclaré.
    const breve = splitSentences(
      "En vue d'un potentiel départ de Lamine Camara, l'AS Monaco veut recruter " +
        "Pape Matar Sarr.",
    );
    const v = acceptClaim(
      claim({
        player: "Pape Matar Sarr",
        fromClub: null,
        toClub: "AS Monaco",
        feeText: null,
        feeKind: "transfert",
        stance: "rumeur",
        sentence: 0,
      }),
      breve,
    );
    assert.ok(v.ok, "le sens juste ne doit pas être rejeté par le voisinage");
  });
});
