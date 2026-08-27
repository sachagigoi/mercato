import { z } from "zod";

import { FEE_KINDS, QUALIFIERS, STANCES } from "./extract/claims.ts";
import { normalizeName } from "./format.ts";
import { resolveLigue1Club } from "./referential.ts";

/**
 * Point de passage UNIQUE vers `press_articles` et `declarations`.
 *
 * Même rôle que `lib/ingest.ts` pour `transfers`, et même raison : toute
 * donnée entrante doit subir la même validation, la même résolution et le
 * même dédoublonnage, quel que soit le worker qui l'envoie.
 *
 * La règle qui structure ce module : **le worker rapporte ce qu'il a lu, le
 * serveur décide ce que ça veut dire.** Les clés de clubs sont recalculées
 * ici, à partir des libellés bruts — jamais reprises du corps de la requête.
 * Une correction du référentiel s'applique alors au prochain envoi, sans
 * toucher au mini PC.
 */

/** Taille des lots d'upsert, comme à l'ingestion : assez gros pour limiter les
 *  allers-retours, assez petit pour qu'un échec ne fasse pas tout rejouer. */
export const BATCH_SIZE = 50;

/** Nombre d'erreurs conservées dans le rapport. Au-delà, c'est du bruit. */
const MAX_REPORTED_ERRORS = 10;

/**
 * Une déclaration telle que le worker l'envoie.
 *
 * Volontairement proche d'`AcceptedClaim` (lib/extract/claims.ts), mais sans
 * les champs que le serveur recalcule. Ce qui traverse le réseau, ce sont les
 * observations : le nom lu, la phrase copiée, le montant converti par un
 * parseur testé. Pas les conclusions.
 */
export const RawClaimSchema = z.object({
  player: z.string().min(2).max(80),
  fromClub: z.string().max(80).nullish(),
  toClub: z.string().max(80).nullish(),
  feeEur: z.number().int().nonnegative().max(1_000_000_000).nullish(),
  feeLabel: z.string().max(40).nullish(),
  feeKind: z.enum(FEE_KINDS).default("inconnu"),
  qualifier: z.enum(QUALIFIERS).default("exact"),
  bonusEur: z.number().int().nonnegative().max(1_000_000_000).nullish(),
  stance: z.enum(STANCES).default("rumeur"),
  /** La preuve. Sans citation, une déclaration n'est qu'une affirmation. */
  quote: z.string().min(1).max(2_000),
  feeQuote: z.string().max(2_000).nullish(),
  playerInQuote: z.boolean().default(false),
});

export const RawArticleSchema = z.object({
  source: z.string().min(1).max(80),
  tier: z.number().int().min(1).max(3).default(3),
  guid: z.string().min(1).max(300),
  url: z.string().url().max(500),
  title: z.string().min(1).max(300),
  publishedAt: z.union([z.string(), z.date()]).nullish(),
  claims: z.array(RawClaimSchema).max(20),
});

/**
 * Le corps accepté par `/api/claims`.
 *
 * `model` et `promptVersion` vivent au niveau du lot, pas de la déclaration :
 * un passage tourne avec un modèle, et les répéter par ligne inviterait un
 * worker à envoyer un lot incohérent.
 */
export const PublishSchema = z.object({
  model: z.string().min(1).max(80),
  promptVersion: z.string().min(1).max(20),
  articles: z.array(RawArticleSchema).max(BATCH_SIZE),
});

export type PublishInput = z.input<typeof PublishSchema>;
type ValidArticle = z.output<typeof RawArticleSchema>;
type ValidClaim = z.output<typeof RawClaimSchema>;

export type ArticleRow = {
  source: string;
  source_tier: number;
  guid: string;
  url: string;
  title: string;
  published_at: string;
  last_extracted_at: string;
};

export type DeclarationRow = {
  claim_key: string;
  article_id: string;
  player_name: string;
  player_normalized: string;
  from_club_name: string | null;
  from_club_key: string | null;
  to_club_name: string | null;
  to_club_key: string | null;
  fee_eur: number | null;
  fee_label: string | null;
  fee_kind: (typeof FEE_KINDS)[number];
  qualifier: (typeof QUALIFIERS)[number];
  bonus_eur: number | null;
  stance: (typeof STANCES)[number];
  quote: string;
  fee_quote: string | null;
  player_in_quote: boolean;
  model: string;
  prompt_version: string;
  published_at: string;
};

export interface DeclarationStore {
  /** Upsert des articles sur `guid`. Rend l'identifiant de chacun, par guid. */
  upsertArticles(rows: readonly ArticleRow[]): Promise<Map<string, string>>;
  /** Upsert des déclarations sur `claim_key`. */
  upsertDeclarations(rows: readonly DeclarationRow[]): Promise<void>;
}

export type PublishReport = {
  articles: number;
  declarations: number;
  /** Déclarations valides mais sans club de Ligue 1 : jamais écrites. */
  outOfScope: number;
  errors: string[];
};

/**
 * Clé naturelle de dédoublonnage d'une déclaration.
 *
 * Le modèle et la version de consigne en font partie **exprès** : rejouer un
 * article avec un autre modèle doit créer une ligne comparable à l'ancienne,
 * pas l'écraser. C'est la condition pour qu'un banc d'essai puisse mesurer un
 * changement de modèle sur du vrai corpus.
 *
 * Le montant, lui, n'y figure pas : à modèle et consigne constants, un même
 * article rend le même chiffre (température 0, graine fixe). L'y mettre ferait
 * proliférer les lignes au moindre écart de parsing.
 */
export function claimKey(
  guid: string,
  claim: { player: string; fromKey: string | null; toKey: string | null },
  model: string,
  promptVersion: string,
): string {
  return [
    guid,
    normalizeName(claim.player),
    claim.fromKey ?? "-",
    claim.toKey ?? "-",
    model,
    promptVersion,
  ].join("|");
}

/**
 * Date de publication utilisable, ou l'instant présent.
 *
 * Un flux qui rend une date illisible ne doit pas faire tomber le lot : une
 * brève horodatée à l'heure de réception vaut mieux qu'une brève perdue.
 */
function publishedAt(value: string | Date | null | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/**
 * Une déclaration entre-t-elle dans le périmètre du produit ?
 *
 * Au moins un club de Ligue 1, entrant ou sortant. Le contrôle est refait ici
 * alors que le worker l'a déjà fait : le serveur ne peut pas présumer de qui
 * lui écrit, et c'est le référentiel de Vercel qui fait foi.
 */
const inScope = (from: string | null, to: string | null) => from !== null || to !== null;

/**
 * Écrit un lot d'articles et leurs déclarations.
 *
 * Idempotent : rejouer le même lot ne crée rien de neuf. C'est ce qui permet
 * au worker de retenter sans état après une coupure réseau — le journal local
 * du mini PC n'a pas à être la source de vérité.
 */
export async function publishDeclarations(
  input: unknown,
  store: DeclarationStore,
  options: { now?: () => Date } = {},
): Promise<PublishReport> {
  const now = options.now?.() ?? new Date();
  const parsed = PublishSchema.parse(input);

  const articles = dedupeByGuid(parsed.articles);
  const report: PublishReport = { articles: 0, declarations: 0, outOfScope: 0, errors: [] };
  if (articles.length === 0) return report;

  const articleRows = articles.map(
    (a): ArticleRow => ({
      source: a.source,
      source_tier: a.tier,
      guid: a.guid,
      url: a.url,
      title: a.title,
      published_at: publishedAt(a.publishedAt, now),
      last_extracted_at: now.toISOString(),
    }),
  );

  const ids = await store.upsertArticles(articleRows);
  report.articles = articleRows.length;

  const rows: DeclarationRow[] = [];
  for (const article of articles) {
    const articleId = ids.get(article.guid);
    if (!articleId) {
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        report.errors.push(`${article.guid} : article sans identifiant après upsert`);
      }
      continue;
    }

    const at = publishedAt(article.publishedAt, now);
    for (const claim of article.claims) {
      const row = toRow(claim, article.guid, articleId, at, parsed.model, parsed.promptVersion);
      if (!row) {
        report.outOfScope += 1;
        continue;
      }
      rows.push(row);
    }
  }

  // Dédoublonnage dans le lot lui-même : deux déclarations du même article
  // sur le même joueur et la même route partagent leur clé, et Postgres
  // refuse un ON CONFLICT qui touche deux fois la même ligne dans un lot.
  const unique = new Map(rows.map((r) => [r.claim_key, r]));
  for (const batch of chunk([...unique.values()], BATCH_SIZE)) {
    await store.upsertDeclarations(batch);
  }
  report.declarations = unique.size;

  return report;
}

function toRow(
  claim: ValidClaim,
  guid: string,
  articleId: string,
  at: string,
  model: string,
  promptVersion: string,
): DeclarationRow | null {
  const from = resolveLigue1Club(claim.fromClub);
  const to = resolveLigue1Club(claim.toClub);
  const fromKey = from?.tmId ?? null;
  const toKey = to?.tmId ?? null;
  if (!inScope(fromKey, toKey)) return null;

  return {
    claim_key: claimKey(guid, { player: claim.player, fromKey, toKey }, model, promptVersion),
    article_id: articleId,
    player_name: claim.player.trim(),
    player_normalized: normalizeName(claim.player),
    from_club_name: claim.fromClub?.trim() || null,
    from_club_key: fromKey,
    to_club_name: claim.toClub?.trim() || null,
    to_club_key: toKey,
    fee_eur: claim.feeEur ?? null,
    fee_label: claim.feeLabel?.trim() || null,
    fee_kind: claim.feeKind,
    qualifier: claim.qualifier,
    bonus_eur: claim.bonusEur ?? null,
    stance: claim.stance,
    quote: claim.quote,
    fee_quote: claim.feeQuote?.trim() || null,
    player_in_quote: claim.playerInQuote,
    model,
    prompt_version: promptVersion,
    published_at: at,
  };
}

/** Le dernier envoi d'un guid l'emporte : c'est le passage le plus récent. */
function dedupeByGuid(articles: readonly ValidArticle[]): ValidArticle[] {
  const byGuid = new Map<string, ValidArticle>();
  for (const article of articles) byGuid.set(article.guid, article);
  return [...byGuid.values()];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
