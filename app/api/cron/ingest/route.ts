import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { ingest } from "@/lib/ingest";
import { resolveMarketValues } from "@/lib/market-value";
import { resolveMedia } from "@/lib/resolve-media";
import { createApiFootballHttp } from "@/lib/sources/apifootball";
import { createHtmlFetcher, fetchRumours } from "@/lib/sources/transfermarkt";
import {
  createMarketValueStore,
  createMediaResolutionStores,
  createSupabaseStores,
} from "@/lib/supabase/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Compare le jeton porteur au secret, à durée constante.
 *
 * Un secret absent ferme l'endpoint au lieu de l'ouvrir : c'est un point
 * d'écriture sur la base, le défaut sûr est le refus. Une comparaison naïve
 * `===` fuirait la longueur du préfixe commun.
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

async function run(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  try {
    const raw = await fetchRumours();
    const ingestion = await ingest(raw, createSupabaseStores());

    // La résolution de visuels suit l'ingestion dans le même passage : la
    // moisson vient de remplir la file, autant la vider tout de suite plutôt
    // que d'attendre le cron suivant pour que les cartes aient leurs logos.
    const media = await resolveMediaIfConfigured();

    // Les valeurs de marché ferment la marche : elles demandent une fiche par
    // joueur, quand la moisson et les visuels ne coûtent qu'une page. Les
    // placer en dernier garantit qu'un incident sur Transfermarkt ne prive
    // jamais le feed de ses rumeurs — il le prive au pire de ses montants,
    // qui arriveront au passage suivant.
    const marketValues = await resolveMarketValues({
      queue: createMarketValueStore(),
      http: createHtmlFetcher(),
    });

    return NextResponse.json({ ingestion, media, marketValues });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Complément facultatif, plus la source principale.
 *
 * Transfermarkt fournit désormais portraits ET écussons directement dans la
 * page des rumeurs, sans clé ni quota. API-Football ne sert plus qu'à combler
 * les rares clubs dont la page ne donnerait pas d'écusson.
 *
 * Sans `API_FOOTBALL_KEY`, l'ingestion est donc pleinement fonctionnelle et les
 * cartes ont leurs visuels. Une clé absente ou révoquée ne doit jamais faire
 * échouer la moisson.
 */
async function resolveMediaIfConfigured() {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return { skipped: "API_FOOTBALL_KEY absente" } as const;

  return resolveMedia({
    ...createMediaResolutionStores(),
    http: createApiFootballHttp(apiKey),
  });
}

/** Vercel Cron appelle en GET ; POST reste ouvert pour un déclenchement manuel. */
export const GET = run;
export const POST = run;
