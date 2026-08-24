import { ACCENT, type Accent } from "@/lib/accent";

/**
 * Pastille de statut. Le libellé vient de la base (`status_badge`), la couleur
 * non : elle est dérivée de (type, probabilité) par accentOf(). Voir lib/accent.ts.
 */
export function StatusBadge({ label, accent }: { label: string | null; accent: Accent }) {
  if (!label) return null;
  const a = ACCENT[accent];

  return (
    <span
      title={label}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-[3px] text-[10px] font-bold tracking-[0.08em] whitespace-nowrap uppercase ${a.chip}`}
    >
      <span className={`size-[5px] shrink-0 rounded-full ${a.dot}`} aria-hidden />
      {/* Le libellé vient de l'ingestion : il peut être arbitrairement long.
          On tronque plutôt que de laisser la pastille passer sur deux lignes,
          et le texte complet reste accessible en title. */}
      <span className="truncate">{label}</span>
    </span>
  );
}
