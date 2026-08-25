// Même choix que lib/sources/apifootball.ts : aucun secret lu ici, donc pas de
// `import "server-only"`, pour rester testable directement.
import { searchClub, searchPlayer, type ApiFootballHit, type ApiFootballHttp } from "./sources/apifootball.ts";

export type MediaKind = "club" | "player";

export type PendingMedia = {
  kind: MediaKind;
  name_normalized: string;
  /** Nom tel qu'écrit par la source. Sert la requête ; jamais la clé de cache. */
  display_name: string;
};

export interface MediaQueue {
  /** Entrées non résolues, `miss_count < 3`, les plus anciennes d'abord. */
  listPending(limit: number): Promise<PendingMedia[]>;
  markResolved(kind: MediaKind, nameNormalized: string, hit: ApiFootballHit): Promise<void>;
  markMissed(kind: MediaKind, nameNormalized: string): Promise<void>;
}

export interface DailyBudget {
  /**
   * Réserve un appel si le plafond du jour n'est pas atteint.
   * Doit être atomique : deux exécutions qui se chevauchent ne doivent jamais
   * ensemble dépasser la limite.
   */
  tryConsumeOne(): Promise<boolean>;
}

export type ResolveMediaReport = {
  attempted: number;
  resolved: number;
  missed: number;
  budgetExhausted: boolean;
};

/**
 * Traite la file de visuels en attente, sous contrainte de budget.
 *
 * Chaque ligne coûte au plus un appel — les échecs (`markMissed`) ne sont PAS
 * retentés dans le même run, ce plafond de 3 (`miss_count < 3`, côté requête
 * `listPending`) vit dans la mise en œuvre du store, pas ici. Dès que le budget
 * est épuisé, on s'arrête net : mieux vaut résoudre 80 visuels aujourd'hui et
 * reprendre demain que de risquer de dépasser le quota réel de la source.
 */
export async function resolveMedia(
  deps: { queue: MediaQueue; budget: DailyBudget; http: ApiFootballHttp },
  options: { batchSize?: number } = {},
): Promise<ResolveMediaReport> {
  const batchSize = options.batchSize ?? 40;
  const pending = await deps.queue.listPending(batchSize);

  const report: ResolveMediaReport = { attempted: 0, resolved: 0, missed: 0, budgetExhausted: false };

  for (const item of pending) {
    const allowed = await deps.budget.tryConsumeOne();
    if (!allowed) {
      report.budgetExhausted = true;
      break;
    }

    report.attempted += 1;
    const search = item.kind === "club" ? searchClub : searchPlayer;
    const hit = await search(deps.http, item.display_name);

    if (hit) {
      await deps.queue.markResolved(item.kind, item.name_normalized, hit);
      report.resolved += 1;
    } else {
      await deps.queue.markMissed(item.kind, item.name_normalized);
      report.missed += 1;
    }
  }

  return report;
}
