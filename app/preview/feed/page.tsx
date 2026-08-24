import { MercatoFeed } from "@/components/MercatoFeed";
import { PREVIEW_CASES } from "@/lib/fixtures";
import { DEFAULT_FILTER, isFilterKey, type FilterKey } from "@/lib/filters";

export const metadata = { title: "Banc d'interaction — Mercato", robots: { index: false } };

/**
 * Banc d'interaction du feed.
 *
 * Monte `MercatoFeed` sur des fixtures locales : on y exerce la barre de
 * filtres, les compteurs, la synchronisation d'URL et les états vides sans
 * dépendre de la base. L'abonnement Realtime, lui, ne peut être vérifié qu'avec
 * une base joignable — l'indicateur de connexion bascule alors sur « Différé ».
 *
 * `?empty=1` monte le feed sans aucune ligne, pour lire les quatre messages
 * d'état vide.
 */
export default async function PreviewFeed({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; empty?: string }>;
}) {
  const { f, empty } = await searchParams;
  const initialFilter: FilterKey = isFilterKey(f) ? f : DEFAULT_FILTER;
  const rows = empty === "1" ? [] : PREVIEW_CASES.map((c) => c.transfer);

  return (
    <main className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
      <header className="py-10">
        <p className="font-mono text-[10px] font-bold tracking-[0.22em] text-slate-500 uppercase">
          Interne · hors feed
        </p>
        <h1 className="mt-2 text-4xl font-extrabold tracking-tighter text-slate-50">
          Banc d&apos;interaction
        </h1>
        <p className="mt-3 max-w-xl text-sm text-slate-400">
          <code className="text-slate-300">MercatoFeed</code> sur fixtures locales : filtres,
          compteurs, synchronisation d&apos;URL et états vides. Aucun appel à Supabase.
        </p>
      </header>

      <MercatoFeed initialRows={rows} initialFilter={initialFilter} />
    </main>
  );
}
