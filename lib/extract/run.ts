import type { Article, PressSource } from "../articles.ts";
import { acceptClaim, inScope, type AcceptedClaim, type Rejected } from "./claims.ts";
import type { Extractor } from "./ollama.ts";
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
  /** Durée de l'appel au modèle. Le chiffre qui dit si la cadence tient. */
  ms: number;
};

export type RunReport = {
  listed: number;
  fetched: number;
  extracted: number;
  claims: number;
  rejected: number;
  /** Hors périmètre : déclaration valide, mais sans club de Ligue 1. */
  outOfScope: number;
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
    outOfScope: 0, msTotal: 0, outcomes: [], errors: [],
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
        claims: [], rejected: [], ms: 0,
      };
      report.outcomes.push(outcome);
      options.onArticle?.(outcome);
      continue;
    }

    const started = Date.now();
    let raw: unknown[] = [];
    try {
      ({ claims: raw } = await extractor.extract(gate.sentences));
      report.extracted += 1;
    } catch (cause) {
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        report.errors.push(`extraction ${item.url} : ${cause instanceof Error ? cause.message : "erreur"}`);
      }
      continue;
    }
    const ms = Date.now() - started;
    report.msTotal += ms;

    const claims: AcceptedClaim[] = [];
    const rejected: Rejected[] = [];
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
        continue;
      }
      claims.push(verdict.claim);
    }

    report.claims += claims.length;
    report.rejected += rejected.length;

    const outcome: ArticleOutcome = { article, skipped: null, claims, rejected, ms };
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
