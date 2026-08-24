import "server-only";

import {
  mediaKey,
  type ExistingTransfer,
  type MediaAsset,
  type MediaKey,
  type MediaStore,
  type TransferStore,
} from "@/lib/ingest";
import { normalizeName } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Implémentation Supabase des dépôts consommés par `ingest()`.
 *
 * L'ingestion ne connaît que les interfaces : c'est ce qui permet de la tester
 * intégralement contre un dépôt en mémoire, sans base ni réseau.
 */
export function createSupabaseStores(): { transfers: TransferStore; media: MediaStore } {
  const supabase = createAdminClient();

  const transfers: TransferStore = {
    async findByExternalIds(externalIds) {
      if (externalIds.length === 0) return [];
      const { data, error } = await supabase
        .from("transfers")
        .select("external_id, probability_score, previous_probability, published_at")
        .in("external_id", externalIds);

      if (error) throw new Error(`lecture des lignes existantes : ${error.message}`);
      return (data ?? []) as ExistingTransfer[];
    },

    async upsert(rows) {
      const { error } = await supabase
        .from("transfers")
        .upsert(rows, { onConflict: "external_id", ignoreDuplicates: false });

      if (error) throw new Error(`upsert : ${error.message}`);
    },
  };

  const media: MediaStore = {
    async lookup(keys) {
      const found = new Map<string, MediaAsset>();
      if (keys.length === 0) return found;

      const names = [...new Set(keys.map((k) => normalizeName(k.name)))];
      const { data, error } = await supabase
        .from("media_cache")
        .select("kind, name_normalized, image_url, cutout_url")
        .in("name_normalized", names);

      if (error) throw new Error(`lecture du cache de visuels : ${error.message}`);

      for (const row of data ?? []) {
        found.set(`${row.kind}:${row.name_normalized}`, {
          image_url: row.image_url,
          cutout_url: row.cutout_url,
        });
      }
      return found;
    },

    async enqueue(keys) {
      const unique = new Map<string, MediaKey>();
      for (const key of keys) unique.set(mediaKey(key.kind, key.name), key);
      if (unique.size === 0) return;

      // ignoreDuplicates : on inscrit un inconnu, on ne réinitialise jamais une
      // entrée déjà résolue ni son compteur d'échecs.
      const { error } = await supabase.from("media_cache").upsert(
        [...unique.values()].map((k) => ({
          kind: k.kind,
          name_normalized: normalizeName(k.name),
        })),
        { onConflict: "kind,name_normalized", ignoreDuplicates: true },
      );

      if (error) throw new Error(`file de visuels : ${error.message}`);
    },
  };

  return { transfers, media };
}
