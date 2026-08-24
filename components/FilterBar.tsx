"use client";

import { FILTERS, type FilterKey } from "@/lib/filters";

export type ConnectionStatus = "connecting" | "live" | "polling";

const STATUS: Record<ConnectionStatus, { label: string; dot: string; text: string }> = {
  connecting: { label: "Connexion", dot: "bg-slate-500", text: "text-slate-500" },
  live: { label: "En direct", dot: "bg-emerald-400", text: "text-emerald-400" },
  polling: { label: "Différé 60 s", dot: "bg-amber-400", text: "text-amber-400" },
};

/**
 * Barre de filtres.
 *
 * Les compteurs viennent du jeu chargé, pas d'un COUNT en base : le filtrage se
 * fait en mémoire, donc les nombres affichés sont exactement ce que le clic va
 * montrer. Un compteur serveur pourrait diverger de la grille.
 */
export function FilterBar({
  active,
  counts,
  status,
  onChange,
}: {
  active: FilterKey;
  counts: Record<FilterKey, number>;
  status: ConnectionStatus;
  onChange: (key: FilterKey) => void;
}) {
  const s = STATUS[status];

  return (
    <div className="sticky top-0 z-20 -mx-5 mb-6 border-b border-slate-800/80 bg-[#0b0f17]/85 px-5 backdrop-blur-md sm:-mx-8 sm:px-8">
      <div className="flex items-center gap-1 overflow-x-auto py-2">
        {FILTERS.map((f) => {
          const isActive = f.key === active;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => onChange(f.key)}
              aria-pressed={isActive}
              className={`group relative shrink-0 rounded-lg px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 ${
                isActive ? "text-slate-50" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {f.label}
              <span
                className={`ml-1.5 font-mono text-[11px] tabular-nums ${
                  isActive ? "text-amber-400" : "text-slate-600"
                }`}
              >
                {counts[f.key]}
              </span>
              <span
                aria-hidden
                className={`absolute inset-x-2 -bottom-px h-[2px] rounded-full transition-opacity ${
                  isActive ? "bg-amber-400 opacity-100" : "opacity-0"
                }`}
              />
            </button>
          );
        })}

        <span
          className={`ml-auto flex shrink-0 items-center gap-1.5 pl-4 font-mono text-[10px] font-bold tracking-[0.12em] uppercase ${s.text}`}
          title={
            status === "polling"
              ? "L'abonnement temps réel est indisponible : le feed se rafraîchit toutes les 60 secondes."
              : undefined
          }
        >
          <span
            className={`size-1.5 rounded-full ${s.dot} ${status === "live" ? "animate-pulse" : ""}`}
            aria-hidden
          />
          {s.label}
        </span>
      </div>
    </div>
  );
}
