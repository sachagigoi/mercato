import type { Article, PressSource } from "../articles.ts";
import type { PublishInput } from "../declarations.ts";
import { acceptClaim, dedupeClaims, inScope, type AcceptedClaim, type Rejected } from "./claims.ts";
import { MissingModelError, type Extractor } from "./ollama.ts";
import { prefilter } from "./prefilter.ts";

/**
 * Le passage complet, de la source aux déclarations vérifiées.
 *
 * Pure orchestration : aucune écriture, aucun secret, aucun réseau qui ne
 * passe par une dépendance injectée. C'est ce qui permet de rejouer un flux
 * entier depuis des fixtures et de mesurer un modèle sans rien déployer.
 */

export type ArticleOutcome = {
  article: Article;
  /** Pourquoi l'article n'est pas allé jusqu'au modèle, le cas échéant. */
  skipped: "hors-ligue-1" | "corps-vide" | "deja-vu" | null;
  claims: AcceptedClaim[];
  rejected: Rejected[];
  /**
   * Déclarations justes mais sans club de L1, sur CET article.
   *
   * Comptées par article et pas seulement en total : « le modèle a lu et a
   * pointé hors de France » et « le modèle n'a rien vu » sont deux pannes
   * différentes, qui appellent deux correctifs différents. Les confondre m'a
   * coûté un diagnostic à la main sur la sortie brute.
   */
  outOfScope: number;
  /** Déclarations repliées parce qu'elles répétaient la même, sur cet article. */
  duplicates: number;
  /** Durée de l'appel au modèle. Le chiffre qui dit si la cadence tient. */
  ms: number;
  /**
   * Sortie brute du modèle, et phrases telles qu'elles lui ont été soumises.
   *
   * Sans ça, un rejet ne dit pas *pourquoi* le modèle s'est trompé, et on
   * corrige à l'aveugle. Le premier passage réel s'est soldé par 100 % de
   * rejet sans qu'on puisse voir ce qu'il avait répondu.
   */
  raw: string;
  sentences: readonly string[];
};

export type RunReport = {
  listed: number;
  fetched: number;
  extracted: number;
  claims: number;
  rejected: number;
  /** Hors périmètre : déclaration valide, mais sans club de Ligue 1. */
  outOfScope: number;
  /**
   * Déclarations repliées parce qu'elles répétaient une autre du même article.
   *
   * Un signal de qualité à part entière : le 3B a rendu cinq entrées pour un
   * seul transfert, une par phrase. Les compter comme retenues récompenserait
   * le bavardage.
   */
  duplicates: number;
  /**
   * Articles soumis au modèle dont il n'a **rien** tiré : ni déclaration, ni
   * rejet, ni même une déclaration hors périmètre. Le cadran qui manquait — le
   * taux de rejet mesure la précision, et reste muet sur les oublis. Un passage
   * réel a laissé filer une signature libre à Brest sans qu'aucun chiffre ne
   * s'en aperçoive.
   *
   * Un silence n'est pas une faute en soi : un article de L1 peut ne parler
   * d'aucun mouvement. C'est sa PART qui alerte.
   */
  silent: number;
  msTotal: number;
  outcomes: ArticleOutcome[];
  errors: string[];
};

export type RunOptions = {
  /** Articles déjà traités, par `guid`. Le corpus ne se relit pas deux fois. */
  seen?: ReadonlySet<string>;
  /** Plafond par passage. Sur CPU, c'est le temps qui contraint, pas le quota. */
  limit?: number;
  /** Pause entre deux articles, par correction envers la source. */
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onArticle?: (outcome: ArticleOutcome) => void;
};

const MAX_REPORTED_ERRORS = 5;

export async function runSource(
  source: PressSource,
  extractor: Extractor,
  options: RunOptions = {},
): Promise<RunReport> {
  const seen = options.seen ?? new Set<string>();
  const limit = options.limit ?? 20;
  const spacingMs = options.spacingMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const report: RunReport = {
    listed: 0, fetched: 0, extracted: 0, claims: 0, rejected: 0,
    outOfScope: 0, silent: 0, duplicates: 0, msTotal: 0, outcomes: [], errors: [],
  };

  const items = await source.listRecent();
  report.listed = items.length;

  // Le préfiltre tourne DEUX fois : une première passe sur le titre et le
  // chapô du flux, qui évite d'aller chercher l'article quand il est déjà
  // clair qu'il ne concerne pas la Ligue 1. C'est autant de requêtes en moins
  // chez la source, et c'est gratuit — on a déjà le texte sous la main.
  const candidates = items.filter((item) => {
    if (seen.has(item.guid)) return false;
    const { mentions } = prefilter({ title: item.title, text: item.teaser ?? item.title });
    return mentions.length > 0;
  });

  for (const [index, item] of candidates.slice(0, limit).entries()) {
    if (index > 0) await sleep(spacingMs);

    let article: Article;
    try {
      article = await source.fetchArticle(item);
      report.fetched += 1;
    } catch (cause) {
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        report.errors.push(`${item.url} : ${cause instanceof Error ? cause.message : "erreur"}`);
      }
      continue;
    }

    const gate = prefilter(article);
    if (!gate.pass) {
      const outcome: ArticleOutcome = {
        article,
        skipped: gate.reason === "ok" ? null : gate.reason,
        claims: [], rejected: [], outOfScope: 0, duplicates: 0, ms: 0, raw: "", sentences: gate.sentences,
      };
      report.outcomes.push(outcome);
      options.onArticle?.(outcome);
      continue;
    }

    const started = Date.now();
    let raw: unknown[] = [];
    let rawText = "";
    try {
      ({ claims: raw, raw: rawText } = await extractor.extract(
        gate.sentences,
        gate.mentions.map((c) => c.name),
      ));
      report.extracted += 1;
    } catch (cause) {
      // Un modèle absent ne se répare pas à l'article suivant : insister
      // téléchargerait le reste du flux chez la source pour rien.
      if (cause instanceof MissingModelError) throw cause;
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        report.errors.push(`extraction ${item.url} : ${cause instanceof Error ? cause.message : "erreur"}`);
      }
      continue;
    }
    const ms = Date.now() - started;
    report.msTotal += ms;

    const claims: AcceptedClaim[] = [];
    const rejected: Rejected[] = [];
    let outOfScope = 0;
    for (const candidate of raw) {
      const verdict = acceptClaim(candidate, gate.sentences);
      if (!verdict.ok) {
        rejected.push(verdict.rejected);
        continue;
      }
      // Hors périmètre n'est pas un rejet : la déclaration est juste, elle ne
      // nous concerne pas. Les compter ensemble brouillerait le seul chiffre
      // qui mesure la qualité du modèle.
      if (!inScope(verdict.claim)) {
        report.outOfScope += 1;
        outOfScope += 1;
        continue;
      }
      claims.push(verdict.claim);
    }

    // Replié AVANT de compter : un modèle qui rend cinq fois le même transfert
    // ne doit pas faire cinq fois mieux au tableau de bord.
    const { kept, folded } = dedupeClaims(claims);
    report.duplicates += folded;

    report.claims += kept.length;
    report.rejected += rejected.length;
    if (kept.length === 0 && rejected.length === 0 && outOfScope === 0) report.silent += 1;

    const outcome: ArticleOutcome = {
      article, skipped: null, claims: kept, rejected, outOfScope, duplicates: folded, ms,
      raw: rawText, sentences: gate.sentences,
    };
    report.outcomes.push(outcome);
    options.onArticle?.(outcome);
  }

  return report;
}

/**
 * Taux de rejet du modèle.
 *
 * Le cadran de qualité, lisible sans étiqueter quoi que ce soit : il monte dès
 * qu'un changement de modèle ou de prompt fait dériver l'extraction.
 */
export function rejectionRate(report: RunReport): number {
  const total = report.claims + report.rejected;
  return total === 0 ? 0 : report.rejected / total;
}

/**
 * Le rapport d'un passage, mis en forme pour `/api/claims`.
 *
 * Ce que le worker envoie, ce sont ses **observations** : le nom lu, la
 * citation copiée, le montant converti par un parseur testé. Pas ses
 * conclusions — les clés de clubs sont délibérément absentes, le serveur les
 * recalcule depuis son propre référentiel. Une correction de référentiel
 * s'applique alors sans redéployer le mini PC.
 */
export function toPublishPayload(
  report: RunReport,
  meta: { source: string; tier: number; model: string; promptVersion: string },
): PublishInput {
  return {
    model: meta.model,
    promptVersion: meta.promptVersion,
    articles: report.outcomes
      // Un article sans déclaration retenue n'a rien à dire : l'envoyer
      // remplirait `press_articles` de brèves qui n'enrichissent rien.
      .filter((o) => o.claims.length > 0)
      .map((o) => ({
        source: meta.source,
        tier: meta.tier,
        guid: o.article.guid,
        url: o.article.url,
        title: o.article.title,
        publishedAt: o.article.publishedAt?.toISOString() ?? null,
        claims: o.claims.map((c) => ({
          player: c.player,
          fromClub: c.fromClubRaw,
          toClub: c.toClubRaw,
          feeEur: c.feeEur,
          feeLabel: c.feeLabel,
          feeKind: c.feeKind,
          qualifier: c.qualifier,
          bonusEur: c.bonusEur,
          stance: c.stance,
          quote: c.quote,
          feeQuote: c.feeQuote,
          playerInQuote: c.playerInQuote,
        })),
      })),
  };
}
