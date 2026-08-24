import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { ingest } from "@/lib/ingest";
import { fetchFixtureRumours } from "@/lib/sources/fixtures";
import { createSupabaseStores } from "@/lib/supabase/store";

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
    const raw = await fetchFixtureRumours();
    const report = await ingest(raw, createSupabaseStores());
    return NextResponse.json(report);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Vercel Cron appelle en GET ; POST reste ouvert pour un déclenchement manuel. */
export const GET = run;
export const POST = run;
