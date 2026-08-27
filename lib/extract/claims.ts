import { z } from "zod";

import { formatFee } from "../format.ts";
import { mentionedLigue1Clubs, resolveLigue1Club, type Club } from "../referential.ts";
import { findAmounts, qualifierNear } from "./prefilter.ts";

/**
 * Ce que le modèle rend, et ce qu'on accepte d'en garder.
 *
 * Le principe tient en une phrase : **le modèle ne produit jamais un fait
 * directement affichable**. Il annonce, et le code retrouve dans le texte de
 * quoi l'étayer — un montant introuvable dans l'article est rejeté. C'est ce
 * qui permet de faire tourner un 7B local sur un produit qui affiche de
 * l'argent.
 */

/** Nature de l'opération. Fermée : un modèle contraint ne peut pas inventer de valeur. */
export const FEE_KINDS = ["transfert", "pret", "pret_avec_option", "clause", "libre", "inconnu"] as const;

/** Où en est la piste, selon cette source-là, à ce moment-là. */
export const STANCES = ["rumeur", "discussions", "accord", "officiel", "dementi"] as const;

/**
 * Nuance du montant. « Environ 50 M€ », « au moins 50 M€ » et « jusqu'à 50 M€ »
 * ne disent pas la même chose, et la carte doit pouvoir le refléter plutôt que
 * de les aplatir en un chiffre sec.
 */
export const QUALIFIERS = ["exact", "environ", "minimum", "maximum"] as const;

export const RawClaimSchema = z.object({
  player: z.string().min(2).max(80),
  fromClub: z.string().max(80).nullish(),
  toClub: z.string().max(80).nullish(),
  /**
   * Le montant **tel qu'écrit dans l'article** : « 100 M€ », « 9,3 M€ »,
   * « 18 millions d'euros ». Surtout pas une valeur convertie.
   *
   * Première version demandait des euros, donc une multiplication par un
   * million — exactement ce qu'un modèle de 7 milliards de paramètres fait le
   * plus mal, alors qu'un parseur testé existait déjà à côté. Le modèle
   * désigne, le code calcule : la même règle que pour la citation.
   */
  feeText: z.string().max(40).nullish(),
  feeKind: z.enum(FEE_KINDS).default("inconnu"),
  qualifier: z.enum(QUALIFIERS).default("exact"),
  bonusText: z.string().max(40).nullish(),
  stance: z.enum(STANCES).default("rumeur"),
  /** Indice de la phrase qui énonce le transfert. Pas la phrase : son numéro. */
  sentence: z.number().int().nonnegative(),
  /**
   * Indice de la phrase qui porte le montant. **Un indice, pas une preuve.**
   *
   * Il a d'abord servi de contrôle, et n'a fait que rejeter des extractions
   * justes : le modèle pointe mal bien plus souvent qu'il n'invente. Le code
   * cherche désormais le montant dans tout l'article ; cet indice ne sert plus
   * qu'à départager quand la même valeur revient dans plusieurs phrases.
   */
  feeSentence: z.number().int().nonnegative().nullish(),
});

export type RawClaim = z.input<typeof RawClaimSchema>;

/**
 * Schéma JSON passé à Ollama en `format`.
 *
 * Le décodage contraint garantit que la sortie parse. Ça supprime toute une
 * classe d'échecs — préambule « Voici le JSON : », virgule finale, champ
 * inventé — et c'est ce qui permet à un petit modèle de tenir le rôle : on ne
 * lui demande plus de bien se tenir, on l'en empêche.
 */
export const OLLAMA_FORMAT = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          player: { type: "string" },
          // `null` légal, et pourtant **exigés** : laissés optionnels, un
          // décodeur contraint les omet purement et simplement. Le premier
          // passage a rendu des déclarations sans aucun club, donc toutes
          // hors périmètre. Obliger le modèle à trancher — un nom ou null —
          // vaut mieux que lui laisser le silence.
          fromClub: { type: ["string", "null"] },
          toClub: { type: ["string", "null"] },
          // `null` explicitement autorisé : sans issue légale pour dire
          // « aucun montant », un décodeur contraint en fabrique un.
          feeText: { type: ["string", "null"] },
          feeKind: { type: "string", enum: FEE_KINDS },
          qualifier: { type: "string", enum: QUALIFIERS },
          bonusText: { type: ["string", "null"] },
          stance: { type: "string", enum: STANCES },
          sentence: { type: "integer" },
          feeSentence: { type: ["integer", "null"] },
        },
        required: ["player", "fromClub", "toClub", "feeText", "feeSentence", "feeKind", "stance", "sentence"],
      },
    },
  },
  required: ["claims"],
} as const;

export type AcceptedClaim = {
  player: string;
  fromClub: Club | null;
  toClub: Club | null;
  fromClubRaw: string | null;
  toClubRaw: string | null;
  feeEur: number | null;
  feeLabel: string | null;
  feeKind: (typeof FEE_KINDS)[number];
  qualifier: (typeof QUALIFIERS)[number];
  bonusEur: number | null;
  stance: (typeof STANCES)[number];
  /** Phrase reprise telle quelle du texte, par indice : exacte par construction. */
  quote: string;
  /** Phrase qui porte le montant, quand il y en a un. Souvent la même. */
  feeQuote: string | null;
  /** Le joueur est-il nommé dans la citation même ? Signal de confiance. */
  playerInQuote: boolean;
};

export type Rejected = { reason: string; raw: unknown };
export type Verdict = { ok: true; claim: AcceptedClaim } | { ok: false; rejected: Rejected };

const reject = (reason: string, raw: unknown): Verdict => ({ ok: false, rejected: { reason, raw } });

/**
 * Garde-fou. Rien ne passe sans preuve dans le texte.
 *
 * Un rejet n'est pas une anomalie : c'est la mesure. Le taux de rejet par
 * modèle se lit sans étiquetage manuel et sert de cadran de qualité — s'il
 * grimpe après un changement de modèle ou de prompt, on le voit le jour même.
 */
export function acceptClaim(raw: unknown, sentences: readonly string[]): Verdict {
  const parsed = RawClaimSchema.safeParse(raw);
  if (!parsed.success) return reject(`schéma : ${parsed.error.issues[0]?.message}`, raw);
  const c = parsed.data;

  const quote = sentences[c.sentence];
  if (quote === undefined) return reject("phrase désignée hors du texte", raw);

  // Le joueur doit être nommé dans l'article — mais pas nécessairement dans la
  // phrase citée. Le réflexe inverse paraissait plus sûr et s'est révélé faux
  // à la première brève réelle : « Les Reds seraient prêts à mettre 70 M€ sur
  // la table pour l'international français » ne contient pas « Barcola ». Les
  // journalistes alternent nom et périphrase d'une phrase à l'autre, et exiger
  // le nom dans la citation rejetterait l'essentiel des extractions justes.
  //
  // Ce qui reste verrouillé au niveau de la phrase, c'est le MONTANT — le seul
  // champ qu'une hallucination rendrait coûteux.
  const lastName = c.player.split(/\s+/).at(-1) ?? c.player;
  const article = normalized(sentences.join(" "));
  if (!article.includes(normalized(lastName)))
    return reject("joueur absent de l'article", raw);

  // Le nom présent jusque dans la phrase citée est un signal de confiance en
  // plus, pas une condition : une brève qui parle de trois joueurs mérite
  // d'être pondérée plus prudemment qu'une brève monosujet.
  const playerInQuote = normalized(quote).includes(normalized(lastName));

  // Le montant est CHERCHÉ dans l'article, il n'est plus vérifié à l'endroit
  // que le modèle désigne. Deux passages réels ont montré que le contrôle par
  // phrase ne rejetait que des extractions justes, jamais une hallucination.
  const fee = locateAmount(c.feeText, sentences, c.feeSentence);
  if (fee === "absent") return reject("montant introuvable dans l'article", raw);
  if (fee === "illisible") return reject(`montant illisible : ${c.feeText}`, raw);

  const located = typeof fee === "object" ? fee : null;

  const bonus = locateAmount(c.bonusText, sentences, null);
  const bonusEur = typeof bonus === "object" && bonus !== null ? bonus.eur : null;

  // Un club de L1 attribué doit être cité dans l'article.
  //
  // Le pendant du contrôle sur le joueur et sur le montant, et il devient
  // nécessaire maintenant que la consigne pousse le modèle à remplir les clubs
  // plutôt qu'à les laisser à null. Une piste attribuée au mauvais club est
  // pire qu'une piste manquée — c'est déjà pour ça que « Paris » n'est pas un
  // alias du PSG. La comparaison porte sur l'identifiant, pas sur le libellé :
  // le modèle peut écrire « PSG » là où l'article écrit « Paris Saint-Germain ».
  const fromClub = resolveLigue1Club(c.fromClub);
  const toClub = resolveLigue1Club(c.toClub);
  const cited = new Set(mentionedLigue1Clubs(sentences.join(" ")).map((club) => club.tmId));
  for (const club of [fromClub, toClub]) {
    if (club && !cited.has(club.tmId))
      return reject(`club absent de l'article : ${club.name}`, raw);
  }

  return {
    ok: true,
    claim: {
      player: c.player.trim(),
      fromClubRaw: c.fromClub?.trim() || null,
      toClubRaw: c.toClub?.trim() || null,
      fromClub,
      toClub,
      feeEur: located ? located.eur : null,
      feeLabel: located ? formatFee(located.eur) : null,
      feeKind: c.feeKind,
      // La nuance lue dans le texte l'emporte sur celle du modèle, qui rend
      // « exact » quoi qu'il arrive. Sa valeur reste le repli quand le
      // vocabulaire du journaliste sort de ce que le code sait lire.
      qualifier: located?.qualifier ?? c.qualifier,
      bonusEur,
      stance: c.stance,
      quote,
      feeQuote: located ? sentences[located.sentence] : null,
      playerInQuote,
    },
  };
}

const normalized = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

type Located = { eur: number; sentence: number; qualifier: (typeof QUALIFIERS)[number] | null };

/**
 * Localise dans l'article le montant que le modèle annonce.
 *
 * **On compare des valeurs, plus des caractères, et on cherche le montant
 * dans tout l'article.** Le renversement vient de deux rejets réels, tous deux
 * d'extractions entièrement justes, et tous deux dus à la même cause : le
 * modèle normalise la notation vers celle du titre.
 *
 * - Fofana : le modèle rend « 40 millions d'euros », l'article écrit « 40 M€ ».
 * - Ekomié : le modèle rend « 9,3 M€ », le corps écrit « 9,3 millions d'euros ».
 *
 * Dans les deux cas l'indice de phrase était **juste** — c'est la comparaison
 * littérale qui rejetait. La recherche sur l'article entier vient en second :
 * elle couvre le cas, plus rare, où le modèle pointe mal.
 *
 * Le contrôle ne perd rien au change. Ce qu'il traque, c'est un chiffre
 * plausible et **absent de l'article** — une hallucination reste introuvable
 * où qu'on la cherche. Et le contrôle par phrase ne protégeait pas de ce qu'on
 * croyait : un modèle qui attribue le mauvais chiffre au transfert désigne
 * aussi la phrase où ce chiffre se trouve, donc passait déjà.
 *
 * La comparaison porte sur la **valeur**, pas sur les caractères : c'est le
 * même parseur des deux côtés, celui que `npm test` éprouve sur de la prose
 * française réelle.
 *
 * Trois issues, distinctes exprès : pas de montant annoncé, montant annoncé
 * mais absent du texte (l'hallucination qu'on traque), et montant que le
 * parseur ne sait pas lire (un défaut de notre côté, pas du modèle).
 */
function locateAmount(
  text: string | null | undefined,
  sentences: readonly string[],
  hint: number | null | undefined,
): Located | null | "absent" | "illisible" {
  const value = text?.trim();
  if (!value) return null;

  const [parsed] = findAmounts(value);
  if (!parsed) return "illisible";

  // La nuance se lit dans la phrase où le montant vit réellement, pas dans
  // celle que le modèle désigne : « environ » précède le chiffre, pas la
  // mention du transfert.
  const matches = sentences.flatMap((s, i) => {
    const hit = findAmounts(s).find((a) => a.eur === parsed.eur);
    return hit ? [{ sentence: i, qualifier: qualifierNear(s, hit.at) }] : [];
  });
  if (matches.length === 0) return "absent";

  // L'indice du modèle ne sert plus qu'à départager, quand la même valeur
  // revient plusieurs fois. Il ne peut plus faire rejeter quoi que ce soit.
  const chosen =
    (hint != null ? matches.find((m) => m.sentence === hint) : undefined) ??
    // À défaut, le corps plutôt que le titre : la phrase 0 est le titre, qui
    // résume au lieu de rapporter — et qui abrège les nuances.
    matches.find((m) => m.sentence > 0) ??
    matches[0];

  return { eur: parsed.eur, sentence: chosen.sentence, qualifier: chosen.qualifier };
}

/**
 * Une déclaration est-elle dans le périmètre du produit ?
 *
 * Au moins un des deux clubs doit être en Ligue 1 — c'est la définition d'un
 * transfert entrant ou sortant. Une brève L1 qui parle en passant d'un deal
 * Chelsea -> Nottingham produit une déclaration valide mais hors sujet.
 */
export function inScope(claim: AcceptedClaim): boolean {
  return claim.fromClub !== null || claim.toClub !== null;
}
