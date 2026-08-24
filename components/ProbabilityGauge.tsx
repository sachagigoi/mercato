import { ACCENT, type Accent } from "@/lib/accent";
import { probabilityTrend } from "@/lib/format";

/**
 * Jauge de probabilité — le « Rumourometer ».
 *
 * Affichée pour les seules rumeurs : une prolongation officielle à 100 % est du
 * bruit visuel. La transition sur la largeur est là pour la Phase 2, où un
 * UPDATE Realtime fera glisser la barre vers sa nouvelle valeur au lieu de la
 * faire sauter.
 */
export function ProbabilityGauge({
  score,
  previous,
  accent,
}: {
  score: number | null;
  previous: number | null;
  accent: Accent;
}) {
  if (score == null) return null;

  const a = ACCENT[accent];
  const trend = probabilityTrend(score, previous);

  return (
    <div className="flex items-center gap-2.5 px-4 pb-3.5">
      <div
        role="progressbar"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Probabilité du transfert"
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out ${a.fill}`}
          style={{ width: `${score}%` }}
        />
      </div>

      <span className={`font-mono text-xs font-bold tabular-nums ${a.value}`}>{score}%</span>

      {trend && (
        <span
          className={`font-mono text-[11px] tabular-nums ${
            trend.direction === "up" ? "text-emerald-400" : "text-rose-400"
          }`}
          title={`${trend.delta > 0 ? "+" : ""}${trend.delta} points depuis la dernière mise à jour`}
        >
          {trend.direction === "up" ? "↑" : "↓"}
          {Math.abs(trend.delta)}
        </span>
      )}
    </div>
  );
}
