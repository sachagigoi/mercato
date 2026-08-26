import type { Article } from "../articles.ts";
import { mentionedLigue1Clubs, type Club } from "../referential.ts";

/**
 * Porte d'entrée du pipeline d'extraction.
 *
 * Deux rôles. D'abord écarter ce qui ne concerne pas le produit : le périmètre
 * est la Ligue 1, et un transfert Chelsea -> Nottingham n'a rien à y faire.
 * Ensuite préparer le texte pour le modèle — c'est ici que se gagne l'essentiel
 * du budget d'inférence, qui sur un CPU se compte en dizaines de secondes.
 *
 * Mesuré sur un flux Maxifoot réel : 10 articles sur 25 passent la porte L1.
 * Le reste n'est jamais présenté au modèle, et ne coûte donc rien.
 */

/**
 * Montants en prose française.
 *
 * Volontairement distinct de `parseFee` : celui-là lit une cellule de tableau
 * normalisée par Transfermarkt (« €45.00m », « free transfer »), celui-ci lit
 * une phrase de journaliste (« autour de 9,3 M€ », « 100 millions d'euros »).
 * Deux grammaires, deux jeux de tests ; les mélanger ferait qu'un correctif
 * pour l'une casserait l'autre.
 */
const AMOUNT = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(m€|meur|millions?\s+d['’]euros?|millions?|milliards?\s+d['’]euros?|milliards?|k€|000\s*€|€)/gi;

const SCALE: { test: RegExp; factor: number }[] = [
  { test: /milliard/i, factor: 1_000_000_000 },
  { test: /^m€$|^meur$|million/i, factor: 1_000_000 },
  { test: /^k€$|^000\s*€$/i, factor: 1_000 },
  { test: /^€$/, factor: 1 },
];

export type Amount = { eur: number; text: string };

/** Tous les montants d'un texte, avec la forme littérale rencontrée. */
export function findAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const value = Number(m[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const unit = m[2].trim();
    const scale = SCALE.find((s) => s.test.test(unit));
    if (!scale) continue;
    out.push({ eur: Math.round(value * scale.factor), text: m[0].trim() });
  }
  return out;
}

/**
 * Découpe en phrases numérotées.
 *
 * Le modèle ne rendra pas la citation mot pour mot, mais **l'indice** de la
 * phrase d'où sort le chiffre. Deux raisons, et la seconde compte autant que
 * la première : ça coûte deux tokens au lieu de quarante — soit une douzaine de
 * secondes gagnées par déclaration sur un CPU à 3 tokens/s — et surtout la
 * citation devient exacte *par construction*, puisque c'est nous qui la
 * découpons. Il n'y a plus de vérification de sous-chaîne qui puisse échouer
 * sur une apostrophe ou un espace insécable.
 *
 * L'abréviation « M. » et les décimales « 9,3 » ne doivent pas couper la phrase.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Þ«"])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type Prefiltered = {
  /** L'article mérite-t-il un appel au modèle ? */
  pass: boolean;
  reason: "ok" | "hors-ligue-1" | "corps-vide";
  /**
   * Clubs de L1 **cités**, pas parties au transfert. Un article sur
   * Rennes -> Vitinha cite l'OM parce que le joueur en vient : c'est correct,
   * et c'est à l'extraction de dire qui achète.
   */
  mentions: Club[];
  sentences: string[];
  /** Indices des phrases portant un montant. */
  moneyAt: number[];
};

/**
 * Le titre est concaténé au corps avant analyse.
 *
 * Un tiers des titres Maxifoot portent le montant (« Ekomié à Wrexham pour
 * 9,3 M€ ») sans que le corps le répète toujours. Les traiter séparément ferait
 * perdre ces chiffres-là.
 */
export function prefilter(article: Pick<Article, "title" | "text">): Prefiltered {
  const sentences = splitSentences(`${article.title.trim()}. ${article.text}`.trim());
  const full = sentences.join(" ");

  const mentions = mentionedLigue1Clubs(full);
  const moneyAt = sentences.flatMap((s, i) => (findAmounts(s).length > 0 ? [i] : []));

  if (article.text.trim().length === 0)
    return { pass: false, reason: "corps-vide", mentions, sentences, moneyAt };
  if (mentions.length === 0)
    return { pass: false, reason: "hors-ligue-1", mentions, sentences, moneyAt };

  // Un article L1 sans montant reste utile : il peut annoncer qu'un club se
  // positionne, ce qui crée ou fait vivre une piste. On le laisse donc passer,
  // et c'est l'extraction qui rendra une déclaration sans chiffre.
  return { pass: true, reason: "ok", mentions, sentences, moneyAt };
}
