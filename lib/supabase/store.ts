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
import type { MarketValueQueue, PendingValue } from "@/lib/market-value";
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
      for (const key of keys) {
        const id = mediaKey(key.kind, key.name);
        // Une clé porteuse d'image l'emporte sur une clé nue pour le même nom.
        if (key.imageUrl || !unique.has(id)) unique.set(id, key);
      }
      if (unique.size === 0) return;

      const all = [...unique.values()];
      const withImage = all.filter((k) => k.imageUrl);
      const withoutImage = all.filter((k) => !k.imageUrl);

      // Sans image : simple inscription en file. ignoreDuplicates protège une
      // entrée déjà résolue et son compteur d'échecs.
      if (withoutImage.length > 0) {
        const { error } = await supabase.from("media_cache").upsert(
          withoutImage.map((k) => ({ kind: k.kind, name_normalized: normalizeName(k.name) })),
          { onConflict: "kind,name_normalized", ignoreDuplicates: true },
        );
        if (error) throw new Error(`file de visuels : ${error.message}`);
      }

      // Avec image : on écrit l'URL, y compris sur une entrée existante. Le
      // portrait de la source est plus frais que ce que le cache contenait.
      if (withImage.length > 0) {
        const { error } = await supabase.from("media_cache").upsert(
          withImage.map((k) => ({
            kind: k.kind,
            name_normalized: normalizeName(k.name),
            image_url: k.imageUrl ?? null,
          })),
          { onConflict: "kind,name_normalized", ignoreDuplicates: false },
        );
        if (error) throw new Error(`file de visuels (avec image) : ${error.message}`);
      }
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
        .select("kind, name_normalized")
        .is("image_url", null)
        .lt("miss_count", 3)
        .order("fetched_at", { ascending: true })
        .limit(limit);

      if (error) throw new Error(`lecture de la file de visuels : ${error.message}`);

      return (data ?? []).map(
        (row): PendingMedia => ({
          kind: row.kind as PendingMedia["kind"],
          name_normalized: row.name_normalized,
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

/**
 * Dépôt de la file des valeurs de marché.
 *
 * Séparé lui aussi, pour la même raison que la résolution de visuels : il ne
 * partage avec l'ingestion qu'une table, pas un cycle de vie. Il travaille en
 * revanche sur `transfers` directement plutôt que sur une table de cache — la
 * valeur appartient au joueur, mais elle s'affiche sur la rumeur, et la
 * dénormaliser évite une jointure que ni RLS ni Realtime ne rendraient simple.
 */
export function createMarketValueStore(): MarketValueQueue {
  const supabase = createAdminClient();

  return {
    async listStale(limit, staleBefore) {
      // PostgREST ne sait pas faire de `distinct on`. On surdimensionne la
      // lecture puis on replie côté client : un joueur cité dans plusieurs
      // rumeurs occupe plusieurs lignes, et le lot doit compter des joueurs.
      const { data, error } = await supabase
        .from("transfers")
        .select("tm_player_id, player_name, market_value_fetched_at")
        .not("tm_player_id", "is", null)
        .or(
          `market_value_fetched_at.is.null,market_value_fetched_at.lt.${staleBefore.toISOString()}`,
        )
        .order("market_value_fetched_at", { ascending: true, nullsFirst: true })
        .limit(limit * 4);

      if (error) throw new Error(`file des valeurs de marché : ${error.message}`);

      const byPlayer = new Map<string, PendingValue>();
      for (const row of data ?? []) {
        if (!row.tm_player_id || byPlayer.has(row.tm_player_id)) continue;
        byPlayer.set(row.tm_player_id, {
          tm_player_id: row.tm_player_id,
          player_name: row.player_name,
        });
        if (byPlayer.size === limit) break;
      }
      return [...byPlayer.values()];
    },

    async apply(tmPlayerId, value) {
      // Toutes les rumeurs du joueur d'un coup : une requête réseau, une
      // requête SQL, et autant d'événements Realtime que de cartes concernées.
      const { error } = await supabase
        .from("transfers")
        .update({
          market_value_eur: value.market_value_eur,
          market_value_label: value.market_value_label,
          market_value_fetched_at: new Date().toISOString(),
        })
        .eq("tm_player_id", tmPlayerId);

      if (error) throw new Error(`écriture de la valeur de marché : ${error.message}`);
    },

    async markMissed(tmPlayerId) {
      const { error } = await supabase
        .from("transfers")
        .update({ market_value_fetched_at: new Date().toISOString() })
        .eq("tm_player_id", tmPlayerId);

      if (error) throw new Error(`horodatage de la tentative : ${error.message}`);
    },
  };
}
