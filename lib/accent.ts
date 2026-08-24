import type { TransferType } from "@/lib/types";

export type Accent = "emerald" | "amber" | "sky" | "slate";

/**
 * La couleur d'une carte est une fonction pure de (type, probabilité).
 *
 * Elle n'est délibérément PAS dérivée de `status_badge` : ce champ est du texte
 * libre venu de l'ingestion, et faire dépendre le rendu d'une correspondance de
 * chaîne ("Officialisé" vs "Officiel") casserait la carte à la première faute de
 * frappe. `status_badge` ne porte que le libellé affiché.
 *
 * Effet recherché : une rumeur tiède reste grise, une rumeur chaude s'allume.
 * La température du feed se lit sans lire un mot.
 */
export function accentOf(type: TransferType, probability: number | null): Accent {
  if (type === "TRANSFER") return "emerald";
  if (type === "EXTENSION") return "sky";
  if (type === "RUMOUR") return (probability ?? 0) >= 70 ? "amber" : "slate";
  return "slate";
}

type AccentClasses = {
  /** Pastille de statut : texte + fond + bordure. */
  chip: string;
  /** Point coloré de la pastille. */
  dot: string;
  /** Remplissage de la jauge, halo néon compris. */
  fill: string;
  /** Halo radial derrière le portrait. */
  halo: string;
  /** Valeur numérique de la jauge. */
  value: string;
  /** Couleur littérale, pour les dégradés SVG qui ne prennent pas de classe. */
  hex: string;
};

/**
 * Classes littérales, jamais construites dynamiquement.
 * Tailwind analyse le source en texte brut : `bg-${accent}-400` serait purgé
 * au build et la carte sortirait sans couleur.
 */
export const ACCENT: Record<Accent, AccentClasses> = {
  emerald: {
    chip: "text-emerald-400 bg-emerald-400/10 border-emerald-400/25",
    dot: "bg-emerald-400",
    fill: "bg-linear-to-r from-emerald-400/30 to-emerald-400 shadow-[0_0_10px_-1px_#34d399]",
    halo: "bg-emerald-400",
    value: "text-emerald-400",
    hex: "#34d399",
  },
  amber: {
    chip: "text-amber-400 bg-amber-400/10 border-amber-400/25",
    dot: "bg-amber-400",
    fill: "bg-linear-to-r from-amber-400/30 to-amber-400 shadow-[0_0_10px_-1px_#fbbf24]",
    halo: "bg-amber-400",
    value: "text-amber-400",
    hex: "#fbbf24",
  },
  sky: {
    chip: "text-sky-400 bg-sky-400/10 border-sky-400/25",
    dot: "bg-sky-400",
    fill: "bg-linear-to-r from-sky-400/30 to-sky-400 shadow-[0_0_10px_-1px_#38bdf8]",
    halo: "bg-sky-400",
    value: "text-sky-400",
    hex: "#38bdf8",
  },
  slate: {
    chip: "text-slate-400 bg-slate-400/10 border-slate-400/20",
    dot: "bg-slate-500",
    fill: "bg-linear-to-r from-slate-600/40 to-slate-500",
    halo: "bg-slate-500",
    value: "text-slate-400",
    hex: "#94a3b8",
  },
};
