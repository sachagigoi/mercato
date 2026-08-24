import { MercatoFeed } from "@/components/MercatoFeed";
import { MAX_ROWS } from "@/lib/feed";
import { DEFAULT_FILTER, isFilterKey, type FilterKey } from "@/lib/filters";
import { createServerClient } from "@/lib/supabase/server";
import type { Transfer } from "@/lib/types";

// Le feed est un produit d'actualité : chaque requête doit voir l'état courant
// de la base. La fraîcheur entre deux chargements est le travail de Realtime.
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

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const { rows, error } = await getFeed();

  // Le filtre est lu côté serveur puis passé en prop, plutôt que via
  // useSearchParams : le premier rendu part déjà sur le bon onglet, et la page
  // n'a pas besoin d'une frontière Suspense. `f` vient de l'URL, donc d'une
  // entrée utilisateur : tout ce qui n'est pas une clé connue retombe sur « Tous ».
  const { f } = await searchParams;
  const initialFilter: FilterKey = isFilterKey(f) ? f : DEFAULT_FILTER;

  return (
    <main className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
      <header className="py-10 sm:py-12">
        <p className="font-mono text-[10px] font-bold tracking-[0.22em] text-amber-400/80 uppercase">
          Transferts · Rumeurs · Prolongations
        </p>
        <h1 className="mt-2 text-5xl font-extrabold tracking-tighter text-slate-50 sm:text-6xl">
          Mercato
        </h1>
      </header>

      {error ? (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          Le feed n&apos;a pas pu être chargé : {error}
        </p>
      ) : (
        <MercatoFeed initialRows={rows} initialFilter={initialFilter} />
      )}
    </main>
  );
}
