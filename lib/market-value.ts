// Aucun secret lu ici, donc pas d'`import "server-only"` : même posture que
// resolve-media.ts, le module reste testable sans base ni réseau.
import { fetchMarketValue, type HtmlFetcher } from "./sources/transfermarkt.ts";
import type { ParsedMarketValue } from "./format.ts";

/** Un joueur à estimer, et non une rumeur : c'est tout l'intérêt du regroupement. */
export type PendingValue = {
  tm_player_id: string;
  player_name: string;
};

export interface MarketValueQueue {
  /**
   * Joueurs dont la valeur manque ou a vieilli, les plus anciens d'abord.
   *
   * Renvoie un joueur, pas une ligne de `transfers` : un joueur cité dans trois
   * rumeurs coûterait sinon trois requêtes pour trois fois la même réponse.
   */
  listStale(limit: number, staleBefore: Date): Promise<PendingValue[]>;
  /** Écrit la valeur sur TOUTES les rumeurs de ce joueur. */
  apply(tmPlayerId: string, value: ParsedMarketValue): Promise<void>;
  /** Marque la tentative sans valeur, pour ne pas y revenir au prochain passage. */
  markMissed(tmPlayerId: string): Promise<void>;
}

export type MarketValueReport = {
  attempted: number;
  resolved: number;
  missed: number;
  errors: string[];
};

/** Au-delà, une valeur est relue. Transfermarkt réestime par campagnes, pas en continu. */
export const STALE_AFTER_DAYS = 7;

const MAX_REPORTED_ERRORS = 5;

/**
 * Échecs d'affilée au-delà desquels on arrête le lot.
 *
 * Trois fiches qui tombent coup sur coup, ce n'est plus un joueur en cause mais
 * la source : continuer brûlerait les soixante secondes de la route sans rien
 * résoudre. Les lignes non tentées gardent `market_value_fetched_at` à null et
 * repartiront en tête de file au passage suivant.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Complète les valeurs de marché manquantes, une fiche à la fois.
 *
 * Le lot est petit et espacé volontairement. Ce n'est pas un quota qui contraint
 * — Transfermarkt n'en impose pas — mais la correction : une page toutes les
 * 1,2 s pendant douze secondes, contre une page toutes les 30 minutes pour la
 * moisson elle-même. Le reste se rattrape au passage suivant, et la valeur
 * arrive sur les cartes déjà ouvertes par Realtime, comme les portraits détourés.
 *
 * Une fiche qui échoue n'interrompt pas les autres : une valeur manquante fait
 * une carte sans montant, ce que la carte sait afficher, alors qu'une exception
 * ferait échouer toute la route d'ingestion pour un détail décoratif.
 */
export async function resolveMarketValues(
  deps: {
    queue: MarketValueQueue;
    http: HtmlFetcher;
    /** Injecté pour que les tests n'attendent pas réellement. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  },
  options: { batchSize?: number; spacingMs?: number } = {},
): Promise<MarketValueReport> {
  const batchSize = options.batchSize ?? 10;
  const spacingMs = options.spacingMs ?? 1_200;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now?.() ?? new Date();

  const staleBefore = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1_000);
  const pending = await deps.queue.listStale(batchSize, staleBefore);

  const report: MarketValueReport = { attempted: 0, resolved: 0, missed: 0, errors: [] };
  let consecutiveFailures = 0;

  for (const [index, player] of pending.entries()) {
    if (index > 0) await sleep(spacingMs);
    report.attempted += 1;

    try {
      const value = await fetchMarketValue(player.tm_player_id, deps.http);
      consecutiveFailures = 0;

      if (value) {
        await deps.queue.apply(player.tm_player_id, value);
        report.resolved += 1;
      } else {
        // Fiche lue, mais sans estimation : Transfermarkt n'évalue pas tout le
        // monde. On horodate quand même la tentative, sinon ce joueur reviendrait
        // en tête de file à chaque passage et bloquerait une place pour rien.
        await deps.queue.markMissed(player.tm_player_id);
        report.missed += 1;
      }
    } catch (cause) {
      consecutiveFailures += 1;
      report.missed += 1;
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        const message = cause instanceof Error ? cause.message : "erreur inconnue";
        report.errors.push(`${player.player_name} : ${message}`);
      }
      // Volontairement pas de `markMissed` ici : une fiche injoignable est
      // presque toujours un incident réseau, pas un joueur sans valeur. La
      // condamner à sept jours de silence pour une coupure de dix secondes
      // serait une punition disproportionnée.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }
  }

  return report;
}
