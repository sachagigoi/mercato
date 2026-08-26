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
  feeEur: z.number().nonnegative().nullish(),
  feeKind: z.enum(FEE_KINDS).default("inconnu"),
  qualifier: z.enum(QUALIFIERS).default("exact"),
  bonusEur: z.number().nonnegative().nullish(),
  stance: z.enum(STANCES).default("rumeur"),
  /** Indice de la phrase d'où sort l'information. Pas la phrase : son numéro. */
  sentence: z.number().int().nonnegative(),
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
          fromClub: { type: "string" },
          toClub: { type: "string" },
          feeEur: { type: "number" },
          feeKind: { type: "string", enum: FEE_KINDS },
          qualifier: { type: "string", enum: QUALIFIERS },
          bonusEur: { type: "number" },
          stance: { type: "string", enum: STANCES },
          sentence: { type: "integer" },
        },
        required: ["player", "stance", "sentence"],
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

  const feeEur = c.feeEur ?? null;
  if (feeEur !== null) {
    // Le montant doit être retrouvable dans la phrase désignée. C'est le
    // contrôle qui attrape l'hallucination la plus coûteuse : un chiffre
    // plausible, bien formé, et absent de l'article.
    const found = findAmounts(quote).some((a) => a.eur === feeEur);
    if (!found) return reject("montant introuvable dans la phrase citée", raw);
  }

  return {
    ok: true,
    claim: {
      player: c.player.trim(),
      fromClubRaw: c.fromClub?.trim() || null,
      toClubRaw: c.toClub?.trim() || null,
      fromClub: resolveLigue1Club(c.fromClub),
      toClub: resolveLigue1Club(c.toClub),
      feeEur,
      feeLabel: feeEur === null ? null : formatFee(feeEur),
      feeKind: c.feeKind,
      qualifier: c.qualifier,
      bonusEur: c.bonusEur ?? null,
      stance: c.stance,
      quote,
      playerInQuote,
    },
  };
}

const normalized = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

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
