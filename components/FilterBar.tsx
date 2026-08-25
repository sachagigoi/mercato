"use client";

import { FILTERS, type CountryOption, type FilterKey } from "@/lib/filters";
import { flagEmoji } from "@/lib/format";

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
  countries,
  activeCountry,
  status,
  onChange,
  onCountryChange,
}: {
  active: FilterKey;
  counts: Record<FilterKey, number>;
  countries: readonly CountryOption[];
  activeCountry: string;
  status: ConnectionStatus;
  onChange: (key: FilterKey) => void;
  onCountryChange: (key: string) => void;
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

      {/*
        Seconde rangée, volontairement plus discrète que la première : le type
        d'info est la coupe principale, le pays une précision. Deux rangées de
        même poids se disputeraient le regard et donneraient une barre qui pèse
        plus lourd que le feed qu'elle filtre.

        Elle disparaît quand il n'y a qu'un seul pays à proposer — une puce
        « Tous les pays » seule ne filtre rien et ne ferait que voler de la
        hauteur à une barre déjà collante.
      */}
      {countries.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-slate-800/60 py-1.5">
          {countries.map((c) => {
            const isActive = c.key === activeCountry;
            const flag = flagEmoji(c.code);
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => onCountryChange(c.key)}
                aria-pressed={isActive}
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 ${
                  isActive
                    ? "border-slate-600 bg-slate-800 text-slate-100"
                    : "border-transparent text-slate-500 hover:bg-slate-900 hover:text-slate-300"
                }`}
              >
                {flag && (
                  <span className="mr-1" aria-hidden>
                    {flag}
                  </span>
                )}
                {c.label}
                <span
                  className={`ml-1.5 font-mono tabular-nums ${
                    isActive ? "text-amber-400" : "text-slate-600"
                  }`}
                >
                  {c.count}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
