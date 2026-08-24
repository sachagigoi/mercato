import { MercatoCard } from "@/components/MercatoCard";
import { createServerClient } from "@/lib/supabase/server";
import type { Transfer } from "@/lib/types";

// Le feed est un produit d'actualité : chaque requête doit voir l'état courant
// de la base. La fraîcheur entre deux chargements est le travail de Realtime (Phase 2).
export const dynamic = "force-dynamic";

const FEED_SIZE = 60;

async function getFeed(): Promise<{ rows: Transfer[]; error: string | null }> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("transfers")
      .select("*")
      .order("published_at", { ascending: false })
      .limit(FEED_SIZE);

    if (error) return { rows: [], error: error.message };
    return { rows: data ?? [], error: null };
  } catch (cause) {
    return { rows: [], error: cause instanceof Error ? cause.message : "Erreur inconnue" };
  }
}

export default async function Home() {
  const { rows, error } = await getFeed();
  const hot = rows.filter((r) => r.type === "RUMOUR" && (r.probability_score ?? 0) >= 70).length;

  return (
    <main className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4 py-10 sm:py-14">
        <div>
          <p className="font-mono text-[10px] font-bold tracking-[0.22em] text-amber-400/80 uppercase">
            Transferts · Rumeurs · Prolongations
          </p>
          <h1 className="mt-2 text-5xl font-extrabold tracking-tighter text-slate-50 sm:text-6xl">
            Mercato
          </h1>
        </div>

        <dl className="flex gap-6 font-mono text-xs">
          <div>
            <dt className="text-[10px] tracking-[0.14em] text-slate-500 uppercase">Infos</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-slate-200">{rows.length}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-[0.14em] text-slate-500 uppercase">
              Rumeurs chaudes
            </dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-amber-400">{hot}</dd>
          </div>
        </dl>
      </header>

      {error && (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          Le feed n&apos;a pas pu être chargé : {error}
        </p>
      )}

      {!error && rows.length === 0 && (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-10 text-center text-sm text-slate-500">
          Aucune info pour le moment.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((t) => (
          <MercatoCard key={t.id} transfer={t} />
        ))}
      </div>
    </main>
  );
}
