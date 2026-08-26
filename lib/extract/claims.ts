import { z } from "zod";

import { formatFee } from "../format.ts";
import { resolveLigue1Club, type Club } from "../referential.ts";
import { findAmounts } from "./prefilter.ts";

/**
 * Ce que le modèle rend, et ce qu'on accepte d'en garder.
 *
 * Le principe tient en une phrase : **le modèle ne produit jamais un fait
 * directement affichable**. Il désigne, et le code vérifie. Un montant qui
 * n'est pas retrouvé dans la phrase que le modèle a lui-même désignée est
 * rejeté — c'est ce qui permet de faire tourner un 7B local sur un produit qui
 * affiche de l'argent.
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
   * Indice de la phrase qui porte le montant, quand ce n'est pas la même.
   *
   * Un article réel a fait tomber la version à un seul indice : « les
   * représentants disposent d'un accord avec l'AS Roma » et « l'OL réclame
   * 40 M€ » sont deux phrases distinctes. Le modèle désignait la première,
   * le montant vivait dans la seconde, et le garde-fou rejetait une
   * extraction pourtant entièrement juste.
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

  // Le montant est vérifié dans SA phrase, qui n'est pas forcément celle qui
  // énonce le transfert. Le contrôle reste au niveau de la phrase — c'est lui
  // qui attrape l'hallucination coûteuse, un chiffre plausible et absent — mais
  // il porte sur la phrase que le modèle désigne pour le montant.
  const feeQuote = sentences[c.feeSentence ?? c.sentence];
  if (c.feeText && feeQuote === undefined)
    return reject("phrase du montant hors du texte", raw);

  const fee = amountFrom(c.feeText, feeQuote ?? "");
  if (fee === "absent") return reject("montant introuvable dans la phrase citée", raw);
  if (fee === "illisible") return reject(`montant illisible : ${c.feeText}`, raw);

  const bonus = amountFrom(c.bonusText, quote);
  const bonusEur = typeof bonus === "number" ? bonus : null;

  return {
    ok: true,
    claim: {
      player: c.player.trim(),
      fromClubRaw: c.fromClub?.trim() || null,
      toClubRaw: c.toClub?.trim() || null,
      fromClub: resolveLigue1Club(c.fromClub),
      toClub: resolveLigue1Club(c.toClub),
      feeEur: typeof fee === "number" ? fee : null,
      feeLabel: typeof fee === "number" ? formatFee(fee) : null,
      feeKind: c.feeKind,
      qualifier: c.qualifier,
      bonusEur,
      stance: c.stance,
      quote,
      feeQuote: typeof fee === "number" ? (feeQuote ?? null) : null,
      playerInQuote,
    },
  };
}

const normalized = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Espaces fine et insécable comprises : « 100 M€ » s'écrit de plusieurs façons. */
const loose = (s: string) => normalized(s).replace(/[\s\u202f\u00a0]+/g, "");

/**
 * Montant recopié -> euros, sous condition qu'il vienne bien de la phrase.
 *
 * Trois issues, distinctes exprès : pas de montant annoncé, montant annoncé
 * mais absent du texte (l'hallucination qu'on traque), et montant présent mais
 * que le parseur ne sait pas lire (un défaut de notre côté, pas du modèle).
 */
function amountFrom(text: string | null | undefined, quote: string): number | null | "absent" | "illisible" {
  const value = text?.trim();
  if (!value) return null;
  if (!loose(quote).includes(loose(value))) return "absent";
  const [amount] = findAmounts(value);
  return amount ? amount.eur : "illisible";
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
