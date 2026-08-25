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
import type { DailyBudget, MediaQueue, PendingMedia } from "@/lib/resolve-media";
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
          display_name: k.name,
        })),
        { onConflict: "kind,name_normalized", ignoreDuplicates: true },
      );

      if (error) throw new Error(`file de visuels : ${error.message}`);
    },
  };

  return { transfers, media };
}

/**
 * Dépôts consommés par `resolveMedia()` (§6.5 des specs — worker de visuels).
 *
 * Séparés de `createSupabaseStores()` : l'ingestion et la résolution de
 * visuels sont deux responsabilités qui ne partagent qu'une table, pas un
 * cycle de vie. Les grouper aurait fait grossir une seule fonction sans raison.
 */
export function createMediaResolutionStores(): { queue: MediaQueue; budget: DailyBudget } {
  const supabase = createAdminClient();

  const queue: MediaQueue = {
    async listPending(limit) {
      const { data, error } = await supabase
        .from("media_cache")
        .select("kind, name_normalized, display_name")
        .is("image_url", null)
        .lt("miss_count", 3)
        .order("fetched_at", { ascending: true })
        .limit(limit);

      if (error) throw new Error(`lecture de la file de visuels : ${error.message}`);

      return (data ?? []).map(
        (row): PendingMedia => ({
          kind: row.kind as PendingMedia["kind"],
          name_normalized: row.name_normalized,
          // Repli sur le nom normalisé pour une ligne antérieure à display_name.
          // La table est vide en Phase 4 ; ce repli n'a pas vocation à durer.
          display_name: row.display_name ?? row.name_normalized,
        }),
      );
    },

    async markResolved(kind, nameNormalized, hit) {
      const { error } = await supabase
        .from("media_cache")
        .update({ af_id: hit.af_id, image_url: hit.image_url, fetched_at: new Date().toISOString() })
        .eq("kind", kind)
        .eq("name_normalized", nameNormalized);

      if (error) throw new Error(`écriture du visuel résolu : ${error.message}`);
    },

    async markMissed(kind, nameNormalized) {
      // Lecture puis écriture, pas atomique — à la différence du budget API,
      // où la course changeait un plafond dur. Ici, la pire conséquence d'une
      // course entre deux runs qui se chevauchent est un miss_count sous-compté
      // d'une unité : une ligne retentée un peu plus que 3 fois. Sans enjeu
      // pour un cron qui tourne seul toutes les 30 minutes.
      const { data: current, error: readError } = await supabase
        .from("media_cache")
        .select("miss_count")
        .eq("kind", kind)
        .eq("name_normalized", nameNormalized)
        .single();

      if (readError) throw new Error(`lecture avant échec : ${readError.message}`);

      const { error } = await supabase
        .from("media_cache")
        .update({ miss_count: current.miss_count + 1, fetched_at: new Date().toISOString() })
        .eq("kind", kind)
        .eq("name_normalized", nameNormalized);

      if (error) throw new Error(`écriture de l'échec : ${error.message}`);
    },
  };

  const budget: DailyBudget = {
    async tryConsumeOne() {
      const { data, error } = await supabase.rpc("consume_api_budget", { daily_cap: 80 });
      if (error) throw new Error(`budget API-Football : ${error.message}`);
      return data === true;
    },
  };

  return { queue, budget };
}
