import { z } from "zod";

import { normalizeName, parseFee } from "./format.ts";
import type { TransferInsert, TransferType } from "./types.ts";

/** Taille des lots d'upsert. Assez gros pour limiter les allers-retours, assez
 *  petit pour qu'un échec ne fasse pas repartir toute la moisson. */
export const BATCH_SIZE = 50;

/** Nombre de messages d'erreur conservés dans le rapport. Au-delà, c'est du bruit. */
const MAX_REPORTED_ERRORS = 10;

export const TRANSFER_TYPES = ["TRANSFER", "RUMOUR", "EXTENSION"] as const;

/**
 * Donnée brute, quelle que soit la source.
 *
 * Tout est optionnel sauf l'identité et le type : une source qui ne renseigne
 * ni club ni montant doit quand même pouvoir entrer. Mieux vaut une carte
 * incomplète qu'une info absente.
 */
export const RawTransferSchema = z.object({
  externalId: z.string().min(1).max(200),
  playerName: z.string().min(1).max(120),
  nationalityCode: z.string().length(2).nullish(),
  fromClub: z.string().max(120).nullish(),
  toClub: z.string().max(120).nullish(),
  fee: z.string().max(120).nullish(),
  type: z.enum(TRANSFER_TYPES),
  probability: z.number().int().min(0).max(100).nullish(),
  statusLabel: z.string().max(80).nullish(),
  source: z.string().max(80).nullish(),
  sourceUrl: z.string().url().max(500).nullish(),
  publishedAt: z.union([z.string(), z.date()]).nullish(),
});

export type RawTransferInput = z.input<typeof RawTransferSchema>;
type ValidRawTransfer = z.output<typeof RawTransferSchema>;

export type MediaKind = "club" | "player";
export type MediaKey = { kind: MediaKind; name: string };
export type MediaAsset = { image_url: string | null; cutout_url: string | null };

/** Ligne déjà en base, réduite à ce dont l'ingestion a besoin pour décider. */
export type ExistingTransfer = {
  external_id: string;
  probability_score: number | null;
  previous_probability: number | null;
  published_at: string;
};

export interface TransferStore {
  findByExternalIds(externalIds: string[]): Promise<ExistingTransfer[]>;
  upsert(rows: TransferInsert[]): Promise<void>;
}

export interface MediaStore {
  /** Visuels connus, indexés `${kind}:${nom normalisé}`. */
  lookup(keys: MediaKey[]): Promise<Map<string, MediaAsset>>;
  /** Inscrit les inconnus dans la file de résolution (Phase 4). */
  enqueue(keys: MediaKey[]): Promise<void>;
}

export type IngestReport = {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  apiCallsUsed: number;
  durationMs: number;
  errors: string[];
};

export const mediaKey = (kind: MediaKind, name: string) => `${kind}:${normalizeName(name)}`;

/**
 * Valide un lot et sépare le bon grain de l'ivraie.
 * Une ligne invalide est écartée et journalisée : elle ne fait jamais échouer
 * le lot entier. Une source qui change de format ne doit pas geler le feed.
 */
export function validate(raw: readonly unknown[]): {
  valid: ValidRawTransfer[];
  errors: string[];
} {
  const valid: ValidRawTransfer[] = [];
  const errors: string[] = [];

  for (const [index, candidate] of raw.entries()) {
    const parsed = RawTransferSchema.safeParse(candidate);
    if (parsed.success) valid.push(parsed.data);
    else if (errors.length < MAX_REPORTED_ERRORS) {
      const first = parsed.error.issues[0];
      errors.push(`ligne ${index} : ${first.path.join(".") || "(racine)"} — ${first.message}`);
    }
  }

  return { valid, errors };
}

/**
 * Dédoublonne à l'intérieur d'un lot, la dernière occurrence gagnant.
 *
 * Une page source liste régulièrement deux fois la même rumeur (colonne « top »
 * puis « récentes »). Sans ce passage, l'upsert enverrait deux lignes en
 * conflit sur `external_id` dans un même INSERT, ce que Postgres refuse :
 * « ON CONFLICT DO UPDATE command cannot affect row a second time ».
 */
export function dedupe(rows: readonly ValidRawTransfer[]): ValidRawTransfer[] {
  const byExternalId = new Map<string, ValidRawTransfer>();
  for (const row of rows) byExternalId.set(row.externalId, row);
  return [...byExternalId.values()];
}

/**
 * Calcule la valeur de `previous_probability` à écrire.
 *
 * Règle : on ne déplace le repère QUE si la probabilité a bougé. Réécrire
 * `previous = current` à chaque passage effacerait la tendance dès la première
 * moisson sans changement — la flèche ↑12 disparaîtrait vingt minutes après
 * être apparue, alors que l'information est toujours vraie.
 */
export function nextPreviousProbability(
  existing: ExistingTransfer | undefined,
  incoming: number | null,
): number | null {
  if (!existing) return null;
  if (existing.probability_score === incoming) return existing.previous_probability;
  return existing.probability_score;
}

/**
 * Transforme une ligne brute en ligne de base.
 * Ne touche à rien : ni lecture, ni écriture. Testable seule.
 */
export function normalize(
  raw: ValidRawTransfer,
  context: {
    existing?: ExistingTransfer;
    media: Map<string, MediaAsset>;
    now: Date;
  },
): TransferInsert {
  const { existing, media, now } = context;
  const fee = parseFee(raw.fee);
  const probability = raw.probability ?? null;

  const player = media.get(mediaKey("player", raw.playerName));
  const fromClub = raw.fromClub ? media.get(mediaKey("club", raw.fromClub)) : undefined;
  const toClub = raw.toClub ? media.get(mediaKey("club", raw.toClub)) : undefined;

  // `published_at` n'est repris de la base que si la source n'en fournit pas.
  // Sans cette précaution, chaque passage du cron repousserait toutes les
  // rumeurs en tête du feed et le tri chronologique perdrait tout son sens.
  const publishedAt = raw.publishedAt
    ? new Date(raw.publishedAt).toISOString()
    : (existing?.published_at ?? now.toISOString());

  return {
    external_id: raw.externalId,
    player_name: raw.playerName,
    player_photo: player?.image_url ?? null,
    player_cutout: player?.cutout_url ?? null,
    nationality_code: raw.nationalityCode?.toLowerCase() ?? null,
    from_club_name: raw.fromClub ?? null,
    from_club_logo: fromClub?.image_url ?? null,
    to_club_name: raw.toClub ?? null,
    to_club_logo: toClub?.image_url ?? null,
    transfer_fee: fee.transfer_fee,
    fee_value_eur: fee.fee_value_eur,
    type: raw.type as TransferType,
    probability_score: probability,
    previous_probability: nextPreviousProbability(existing, probability),
    status_badge: raw.statusLabel ?? null,
    source: raw.source ?? null,
    source_url: raw.sourceUrl ?? null,
    published_at: publishedAt,
  };
}

/** Découpe un tableau en lots de taille fixe. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Point de passage UNIQUE vers la table `transfers`.
 * Aucun autre module ne doit y écrire : c'est ce qui garantit que toute donnée
 * entrante subit la même validation, la même normalisation et le même upsert.
 */
export async function ingest(
  raw: readonly unknown[],
  stores: { transfers: TransferStore; media: MediaStore },
  options: { now?: () => Date } = {},
): Promise<IngestReport> {
  const started = Date.now();
  const now = options.now?.() ?? new Date();

  const { valid, errors } = validate(raw);
  const rows = dedupe(valid);
  const skipped = raw.length - rows.length;

  if (rows.length === 0) {
    return {
      scanned: raw.length,
      inserted: 0,
      updated: 0,
      skipped,
      apiCallsUsed: 0,
      durationMs: Date.now() - started,
      errors,
    };
  }

  // Visuels : le cache d'abord, toujours. Les inconnus partent en file pour la
  // Phase 4 — aucun appel réseau n'est fait ici.
  const keys: MediaKey[] = [];
  for (const row of rows) {
    keys.push({ kind: "player", name: row.playerName });
    if (row.fromClub) keys.push({ kind: "club", name: row.fromClub });
    if (row.toClub) keys.push({ kind: "club", name: row.toClub });
  }
  const media = await stores.media.lookup(keys);
  const missing = keys.filter((k) => !media.has(mediaKey(k.kind, k.name)));
  if (missing.length > 0) await stores.media.enqueue(missing);

  const externalIds = rows.map((r) => r.externalId);
  const existingRows = await stores.transfers.findByExternalIds(externalIds);
  const existingById = new Map(existingRows.map((r) => [r.external_id, r]));

  const prepared = rows.map((row) =>
    normalize(row, { existing: existingById.get(row.externalId), media, now }),
  );

  for (const batch of chunk(prepared, BATCH_SIZE)) {
    await stores.transfers.upsert(batch);
  }

  return {
    scanned: raw.length,
    inserted: rows.filter((r) => !existingById.has(r.externalId)).length,
    updated: rows.filter((r) => existingById.has(r.externalId)).length,
    skipped,
    apiCallsUsed: 0,
    durationMs: Date.now() - started,
    errors,
  };
}
