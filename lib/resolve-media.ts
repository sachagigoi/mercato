// Même choix que lib/sources/apifootball.ts : aucun secret lu ici, donc pas de
// `import "server-only"`, pour rester testable directement.
import {
  ApiFootballAccessError,
  searchClub,
  searchPlayer,
  type ApiFootballHit,
  type ApiFootballHttp,
} from "./sources/apifootball.ts";

export type MediaKind = "club" | "player";

export type PendingMedia = {
  kind: MediaKind;
  /**
   * Sert à la fois de clé de cache ET de terme de recherche.
   *
   * API-Football refuse tout ce qui n'est pas alphanumérique ou espace —
   * vérifié contre le vrai service : « Paris Saint-Germain » et « Atlético
   * Madrid » sont rejetés avec `The Search field may only contain
   * alpha-numeric characters and spaces`, là où « paris saint germain »
   * renvoie bien le PSG. `normalizeName()` produit exactement cette forme.
   */
  name_normalized: string;
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
  /** Renseigné quand le compte ou la cadence a coupé l'accès. */
  accessError?: string;
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
  deps: {
    queue: MediaQueue;
    budget: DailyBudget;
    http: ApiFootballHttp;
    /** Injecté pour que les tests n'attendent pas réellement. */
    sleep?: (ms: number) => Promise<void>;
  },
  options: { batchSize?: number; spacingMs?: number } = {},
): Promise<ResolveMediaReport> {
  // API-Football plafonne aussi à 10 requêtes/minute — une limite absente de la
  // présentation du plan Free, découverte en interrogeant le vrai service. Sans
  // étalement, un lot se ferait refuser dès la onzième ligne.
  const spacingMs = options.spacingMs ?? 6_500;
  // 8 x 6,5 s = 52 s, sous les 60 s de `maxDuration` de la route. Le facteur
  // limitant est le temps d'exécution, pas le quota : à 8 visuels toutes les
  // 30 minutes, le budget de 80/jour reste le vrai plafond.
  const batchSize = options.batchSize ?? 8;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const pending = await deps.queue.listPending(batchSize);

  const report: ResolveMediaReport = { attempted: 0, resolved: 0, missed: 0, budgetExhausted: false };

  for (const [index, item] of pending.entries()) {
    if (index > 0) await sleep(spacingMs);
    const allowed = await deps.budget.tryConsumeOne();
    if (!allowed) {
      report.budgetExhausted = true;
      break;
    }

    report.attempted += 1;
    const search = item.kind === "club" ? searchClub : searchPlayer;

    let hit: ApiFootballHit | null;
    try {
      hit = await search(deps.http, item.name_normalized);
    } catch (cause) {
      // Compte suspendu ou cadence dépassée : on s'arrête immédiatement sans
      // compter d'échec. Marquer ces lignes en échec les condamnerait au bout
      // de trois passages, alors que le problème ne vient pas d'elles.
      if (cause instanceof ApiFootballAccessError) {
        report.accessError = cause.message;
        break;
      }
      throw cause;
    }

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
