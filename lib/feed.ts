import type { Transfer } from "@/lib/types";

/**
 * Plafond du feed en mémoire.
 * Un onglet laissé ouvert huit heures un jour de deadline reçoit des centaines
 * d'événements : sans plafond, le tableau grossit indéfiniment.
 */
export const MAX_ROWS = 200;

/**
 * Fusionne des lignes entrantes dans l'état courant.
 *
 * Trois garanties, qui répondent aux trois pièges du Realtime (§4.2 des specs) :
 *   - dédoublonnage par `id` — Realtime peut rejouer un événement, et un
 *     `[...prev, nouveau]` naïf afficherait deux fois la même carte ;
 *   - tri stable sur `published_at` décroissant, jamais sur l'ordre d'arrivée ;
 *   - troncature à MAX_ROWS.
 */
export function mergeRows(
  previous: readonly Transfer[],
  incoming: readonly Transfer[],
  removeId?: string,
): Transfer[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  if (removeId) byId.delete(removeId);

  return [...byId.values()]
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, MAX_ROWS);
}

/**
 * Borne haute de `created_at` sur un lot.
 *
 * C'est le repère de rattrapage : entre le rendu serveur et l'établissement de
 * l'abonnement Realtime s'ouvre une fenêtre pendant laquelle les insertions ne
 * sont notifiées à personne. Au passage à SUBSCRIBED, on redemande tout ce qui
 * a été créé après ce repère. Sans ça, ces lignes sont perdues définitivement.
 *
 * Sur un lot vide, on renvoie l'époque zéro : tout est à rattraper.
 */
export function maxCreatedAt(rows: readonly Transfer[]): string {
  let max = new Date(0).toISOString();
  for (const row of rows) {
    if (Date.parse(row.created_at) > Date.parse(max)) max = row.created_at;
  }
  return max;
}
