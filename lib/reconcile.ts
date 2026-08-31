import { formatFee, normalizeName } from "./format.ts";
import type { RawTransferInput } from "./ingest.ts";
import { normalizeClub } from "./referential.ts";
import type { FEE_KINDS, QUALIFIERS, STANCES } from "./extract/claims.ts";

/**
 * Rapprochement déclaration -> piste.
 *
 * C'est la pièce qui relie le pipeline au produit. Sans elle, l'extraction
 * peut être parfaite : `transfer_id` reste nul, et rien n'atteint les cartes.
 *
 * Elle répond à une seule question, article par article : **est-ce qu'on parle
 * d'une piste déjà connue, ou d'une nouvelle ?** Se tromper dans un sens crée
 * un doublon visible dans le feed ; se tromper dans l'autre attribue un montant
 * à la mauvaise piste. Les deux erreurs ne se valent pas, et tout le module
 * penche du côté du doublon.
 */

/** Ce qu'une déclaration en attente apporte au rapprochement. */
export type PendingDeclaration = {
  id: string;
  playerName: string;
  playerNormalized: string;
  fromClubName: string | null;
  toClubName: string | null;
  feeEur: number | null;
  feeKind: (typeof FEE_KINDS)[number];
  qualifier: (typeof QUALIFIERS)[number];
  stance: (typeof STANCES)[number];
  publishedAt: string;
  /** Provenance, reprise de l'article : sert à créer une piste s'il le faut. */
  source: string;
  url: string;
};

/** Une piste déjà en base, réduite à ce dont la décision a besoin. */
export type CandidateTransfer = {
  id: string;
  externalId: string;
  fromClubName: string | null;
  toClubName: string | null;
  feeValueEur: number | null;
};

export interface ReconcileStore {
  /** Déclarations sans piste, les plus récentes d'abord. */
  pending(limit: number): Promise<PendingDeclaration[]>;
  /** Pistes existantes des joueurs concernés, indexées par nom normalisé. */
  candidates(playersNormalized: readonly string[]): Promise<Map<string, CandidateTransfer[]>>;
  /** Rattache une déclaration à sa piste. */
  link(declarationId: string, transferId: string): Promise<void>;
  /** Pose le montant sur la piste. */
  applyFee(transferId: string, fee: { eur: number; label: string }): Promise<void>;
  /** Identifiants des pistes, par clé naturelle. Sert après une création. */
  idsByExternalId(externalIds: readonly string[]): Promise<Map<string, string>>;
}

export type ReconcileReport = {
  pending: number;
  linked: number;
  /** Pistes enrichies d'un montant qu'elles n'avaient pas. */
  enriched: number;
  /** Pistes ouvertes par la presse, comptées en clés distinctes. */
  created: number;
  /** Déclarations laissées en attente, faute de quoi créer une piste. */
  deferred: number;
  errors: string[];
};

const MAX_REPORTED_ERRORS = 10;

/**
 * Quelle piste, parmi celles du joueur, cette déclaration concerne-t-elle ?
 *
 * L'ordre des tests dit tout de la prudence recherchée.
 *
 * 1. **Même destination** : c'est le même transfert, sans discussion possible.
 * 2. **Même origine, et une destination inconnue d'un côté** : la presse parle
 *    d'un départ dont elle ne nomme pas encore l'arrivée, ou l'inverse. C'est
 *    la même piste qui se précise.
 * 3. **Sinon, rien.** Deux destinations nommées et différentes, ce sont deux
 *    pistes — un joueur courtisé par deux clubs, exactement ce que le produit
 *    doit montrer plutôt que d'aplatir.
 *
 * Les clubs étrangers se comparent par leur libellé normalisé, faute de
 * référentiel : « Manchester City » et « Man City » ne se rejoindront pas. On
 * crée alors un doublon, et c'est le bon échec — une carte en trop se voit et
 * se corrige, un montant sur la mauvaise piste se lit comme un fait.
 */
export function matchTransfer(
  declaration: PendingDeclaration,
  candidates: readonly CandidateTransfer[],
): CandidateTransfer | null {
  const to = club(declaration.toClubName);
  const from = club(declaration.fromClubName);

  if (to) {
    const sameDestination = candidates.find((c) => club(c.toClubName) === to);
    if (sameDestination) return sameDestination;
  }

  if (from) {
    const sameOrigin = candidates.find(
      (c) => club(c.fromClubName) === from && (!to || !club(c.toClubName)),
    );
    if (sameOrigin) return sameOrigin;
  }

  return null;
}

const club = (name: string | null) => (name ? normalizeClub(name) || null : null);

/**
 * Encodage de la posture en score affichable.
 *
 * **Ce n'est pas une probabilité calculée**, et il ne faut pas le lire comme
 * telle : c'est la traduction en jauge de ce qu'UNE source affirme. Le
 * Rumourometer de Transfermarkt, lui, reste la valeur d'origine sur les pistes
 * qui en ont une — on ne l'écrase jamais avec ceci.
 */
const STANCE_SCORE: Record<(typeof STANCES)[number], number> = {
  rumeur: 40,
  discussions: 55,
  accord: 75,
  officiel: 100,
  dementi: 10,
};

/**
 * Une déclaration peut-elle donner naissance à une piste ?
 *
 * Deux refus, tous deux volontaires :
 *
 * - **Sans destination nommée**, il n'y a pas de transfert à montrer : une
 *   carte « Fofana -> ? » n'apprend rien. La déclaration reste en attente et
 *   se rattachera à la rumeur Transfermarkt quand elle paraîtra.
 * - **Sur un démenti**, créer reviendrait à faire naître une rumeur d'un
 *   article qui affirme qu'elle est fausse. Un démenti enrichit une piste
 *   existante ; il n'en ouvre pas.
 */
export function canCreate(declaration: PendingDeclaration): boolean {
  return Boolean(club(declaration.toClubName)) && declaration.stance !== "dementi";
}

/**
 * Clé naturelle d'une piste née de la presse.
 *
 * Bâtie sur le joueur et la destination, donc **indépendante de la source** :
 * deux journaux qui rapportent le même mouvement produisent la même clé, et
 * l'ingestion les fond en une piste au lieu de deux cartes.
 */
export function pressExternalId(declaration: PendingDeclaration): string {
  const destination = club(declaration.toClubName) ?? "?";
  return `press:${normalizeName(declaration.playerName)}:${destination}`.replace(/\s+/g, "-");
}

/** Déclaration -> ligne d'ingestion. Le seul chemin d'écriture vers `transfers`. */
export function toRawTransfer(declaration: PendingDeclaration): RawTransferInput {
  return {
    externalId: pressExternalId(declaration),
    playerName: declaration.playerName,
    fromClub: declaration.fromClubName,
    toClub: declaration.toClubName,
    fee: declaration.feeEur !== null ? formatFee(declaration.feeEur) : null,
    type: declaration.stance === "officiel" ? "TRANSFER" : "RUMOUR",
    probability: STANCE_SCORE[declaration.stance],
    source: declaration.source,
    sourceUrl: declaration.url,
    publishedAt: declaration.publishedAt,
  };
}

export type ReconcileOptions = {
  limit?: number;
  /**
   * Crée les pistes manquantes. Injecté plutôt qu'appelé directement pour que
   * `lib/ingest.ts` reste le point de passage UNIQUE vers `transfers` — ce
   * module décide, il n'écrit pas de rumeur lui-même.
   */
  create?: (rows: RawTransferInput[]) => Promise<void>;
};

export async function reconcile(
  store: ReconcileStore,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const limit = options.limit ?? 100;
  const report: ReconcileReport = {
    pending: 0, linked: 0, enriched: 0, created: 0, deferred: 0, errors: [],
  };

  const declarations = await store.pending(limit);
  report.pending = declarations.length;
  if (declarations.length === 0) return report;

  const byPlayer = await store.candidates([
    ...new Set(declarations.map((d) => d.playerNormalized)),
  ]);

  const orphans: PendingDeclaration[] = [];

  for (const declaration of declarations) {
    const match = matchTransfer(declaration, byPlayer.get(declaration.playerNormalized) ?? []);
    if (!match) {
      if (canCreate(declaration)) orphans.push(declaration);
      else report.deferred += 1;
      continue;
    }
    await attach(store, declaration, match, report);
  }

  if (orphans.length > 0 && options.create) {
    await createAndLink(store, orphans, options, report);
  } else {
    report.deferred += orphans.length;
  }

  return report;
}

/**
 * Rattache, et pose le montant si la piste n'en avait pas.
 *
 * **Seulement si elle n'en avait pas.** Une rumeur Transfermarkt arrive sans
 * montant — c'est précisément le trou que la presse comble. Mais un transfert
 * conclu porte le chiffre officiel, et une estimation de presse n'a pas à
 * l'écraser. Le lien est posé dans tous les cas : l'observation est conservée
 * même quand elle ne change rien à l'affichage.
 */
async function attach(
  store: ReconcileStore,
  declaration: PendingDeclaration,
  match: CandidateTransfer,
  report: ReconcileReport,
): Promise<void> {
  try {
    await store.link(declaration.id, match.id);
    report.linked += 1;

    if (declaration.feeEur !== null && match.feeValueEur === null) {
      await store.applyFee(match.id, {
        eur: declaration.feeEur,
        label: formatFee(declaration.feeEur),
      });
      report.enriched += 1;
    }
  } catch (cause) {
    if (report.errors.length < MAX_REPORTED_ERRORS) {
      report.errors.push(`${declaration.playerName} : ${message(cause)}`);
    }
  }
}

/**
 * Crée les pistes manquantes, puis rattache les déclarations qui les ont
 * motivées.
 *
 * En deux temps parce que l'ingestion ne rend pas les identifiants qu'elle
 * écrit : on relit par clé naturelle. Une déclaration dont la piste n'a pas pu
 * être relue reste en attente plutôt que d'être perdue — le passage suivant la
 * reprendra.
 */
async function createAndLink(
  store: ReconcileStore,
  orphans: readonly PendingDeclaration[],
  options: ReconcileOptions,
  report: ReconcileReport,
): Promise<void> {
  const rows = orphans.map(toRawTransfer);

  try {
    await options.create!(rows);
  } catch (cause) {
    report.errors.push(`création : ${message(cause)}`);
    report.deferred += orphans.length;
    return;
  }

  // Compté en clés distinctes, pas en déclarations : deux journaux qui
  // rapportent le même mouvement produisent la même clé et une seule piste.
  const keys = [...new Set(rows.map((r) => r.externalId))];
  report.created += keys.length;

  const ids = await store.idsByExternalId(keys);

  for (const declaration of orphans) {
    const id = ids.get(pressExternalId(declaration));
    if (!id) {
      report.deferred += 1;
      continue;
    }
    try {
      await store.link(declaration.id, id);
      report.linked += 1;
    } catch (cause) {
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        report.errors.push(`${declaration.playerName} : ${message(cause)}`);
      }
    }
  }
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : "erreur");
