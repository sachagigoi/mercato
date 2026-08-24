import { MercatoCard } from "@/components/MercatoCard";
import { PREVIEW_CASES } from "@/lib/fixtures";

export const metadata = { title: "Banc de rendu — Mercato", robots: { index: false } };

/**
 * Banc de rendu des composants.
 *
 * Ne touche pas la base : les cartes sont alimentées par lib/fixtures.ts. C'est
 * là qu'on valide les états qu'un feed nominal ne montre jamais — portrait
 * absent, libellé qui déborde, jauge à 0 et à 100 — et c'est là qu'on revient
 * après chaque retouche du design.
 */
export default function Preview() {
  return (
    <main className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
      <header className="py-10 sm:py-14">
        <p className="font-mono text-[10px] font-bold tracking-[0.22em] text-slate-500 uppercase">
          Interne · hors feed
        </p>
        <h1 className="mt-2 text-4xl font-extrabold tracking-tighter text-slate-50">
          Banc de rendu
        </h1>
        <p className="mt-3 max-w-xl text-sm text-slate-400">
          Les cas limites de <code className="text-slate-300">MercatoCard</code>, alimentés par des
          fixtures locales. Aucun appel à Supabase.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-x-4 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
        {PREVIEW_CASES.map((c) => (
          <section key={c.transfer.id} className="flex flex-col gap-3">
            <div>
              <h2 className="font-mono text-[11px] font-bold tracking-[0.12em] text-slate-300 uppercase">
                {c.title}
              </h2>
              <p className="mt-1 text-[12px] leading-snug text-slate-500">{c.note}</p>
            </div>
            <MercatoCard transfer={c.transfer} />
          </section>
        ))}
      </div>

      <section className="mt-16 border-t border-slate-800 pt-10">
        <h2 className="font-mono text-[11px] font-bold tracking-[0.12em] text-slate-300 uppercase">
          Grille du feed
        </h2>
        <p className="mt-1 max-w-xl text-[12px] leading-snug text-slate-500">
          Les mêmes cartes dans la grille réelle, sans habillage. C&apos;est ici qu&apos;on vérifie
          l&apos;alignement des pieds quand des cartes de hauteurs différentes se retrouvent sur la
          même ligne.
        </p>
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {PREVIEW_CASES.map((c) => (
            <MercatoCard key={`grid-${c.transfer.id}`} transfer={c.transfer} />
          ))}
        </div>
      </section>
    </main>
  );
}
