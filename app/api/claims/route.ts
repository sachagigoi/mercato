import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { publishDeclarations } from "@/lib/declarations";
import { ingest } from "@/lib/ingest";
import { reconcile } from "@/lib/reconcile";
import {
  createDeclarationStore,
  createReconcileStore,
  createSupabaseStores,
} from "@/lib/supabase/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Réception des déclarations extraites par le worker du mini PC.
 *
 * C'est le seul chemin par lequel une observation de presse entre en base.
 * Le worker vit hors de Vercel — le modèle pèse 5 Go, aucune fonction
 * serverless ne le charge — mais il n'a pour autant aucun accès direct à la
 * base : il parle à cet endpoint, qui valide, résout et écrit.
 *
 * Cette frontière est ce qui rend le mini PC remplaçable. Un second worker,
 * une exécution manuelle, un jour une fonction hébergée : tous passent par
 * la même porte et subissent les mêmes contrôles.
 */

/**
 * Même contrôle que le cron d'ingestion, et pour la même raison : un secret
 * absent ferme l'endpoint au lieu de l'ouvrir. C'est un point d'écriture.
 *
 * Le jeton est celui du cron. Un second secret n'ajouterait rien ici : les
 * deux endpoints écrivent dans la même base avec les mêmes droits, et un
 * secret de plus est surtout un secret de plus à ne pas poser.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps illisible" }, { status: 400 });
  }

  try {
    const report = await publishDeclarations(body, createDeclarationStore());

    // Le rapprochement suit l'écriture dans le même passage : une déclaration
    // dont la piste existe déjà doit atteindre la carte tout de suite, pas au
    // cron suivant. Ce qui n'a pas trouvé sa piste reste en file — le balayage
    // qui suit chaque moisson le reprendra, quand la rumeur aura paru.
    const matching = await reconcile(createReconcileStore(), {
      create: (rows) => ingest(rows, createSupabaseStores()).then(() => undefined),
    });

    return NextResponse.json({ ...report, matching });
  } catch (cause) {
    // Un lot malformé est une erreur du client, pas du serveur : le distinguer
    // évite de faire retenter indéfiniment un worker qui envoie du mauvais
    // JSON. Un 500 lui dirait « réessaie », et il réessaierait pour rien.
    if (cause instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Lot invalide", issues: cause.issues.slice(0, 5) },
        { status: 422 },
      );
    }
    const message = cause instanceof Error ? cause.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
