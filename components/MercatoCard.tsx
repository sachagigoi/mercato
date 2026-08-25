import { Crest } from "@/components/Crest";
import { PlayerPortrait } from "@/components/PlayerPortrait";
import { ProbabilityGauge } from "@/components/ProbabilityGauge";
import { StatusBadge } from "@/components/StatusBadge";
import { ACCENT, accentOf } from "@/lib/accent";
import { flagEmoji, relativeTime } from "@/lib/format";
import type { Transfer } from "@/lib/types";

const TYPE_LABEL: Record<Transfer["type"], string> = {
  TRANSFER: "Transfert",
  RUMOUR: "Rumeur",
  EXTENSION: "Prolongation",
};

/** Trajet vendeur -> acheteur. Le dégradé part du neutre et arrive sur l'accent. */
function TransferArrow({ hex }: { hex: string }) {
  return (
    <span className="relative flex w-7 shrink-0 items-center" aria-hidden>
      <span
        className="h-px w-full"
        style={{ backgroundImage: `linear-gradient(90deg, #334155, ${hex})` }}
      />
      <svg viewBox="0 0 8 8" className="-ml-px size-2 shrink-0" style={{ fill: hex }}>
        <path d="M0 0l8 4-8 4z" />
      </svg>
    </span>
  );
}

export function MercatoCard({ transfer: t, className = "" }: { transfer: Transfer; className?: string }) {
  const accent = accentOf(t.type, t.probability_score);
  const a = ACCENT[accent];

  // Une prolongation part et arrive au même club : afficher « Juventus -> Juventus »
  // serait absurde. On rend alors un en-tête à club unique.
  const isRenewal = Boolean(t.from_club_name) && t.from_club_name === t.to_club_name;
  const hasClubs = Boolean(t.from_club_name || t.to_club_name);

  // Le montant n'est affiché que s'il dit quelque chose. Un tiret isolé en gros
  // gras, sur une prolongation, ressemble à un bug plutôt qu'à une absence.
  const fee = t.transfer_fee && t.transfer_fee !== "—" ? t.transfer_fee : null;

  // Deux chiffres possibles, qui ne disent pas la même chose : un prix convenu
  // est un fait, une valeur de marché est une estimation. Le prix l'emporte
  // quand il existe, et dans les deux cas la carte annonce lequel elle montre —
  // « 45 M€ » posé nu sur une rumeur laisserait croire à un accord trouvé.
  const amount = fee
    ? { value: fee, label: "Montant" }
    : t.market_value_label
      ? { value: t.market_value_label, label: "Valeur estimée" }
      : null;

  const body = (
    <>
      <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        {!hasClubs ? (
          // Aucun club connu : une flèche entre deux tirets ne veut rien dire.
          <span className="font-mono text-[10px] font-bold tracking-[0.16em] text-slate-500 uppercase">
            {TYPE_LABEL[t.type]}
          </span>
        ) : isRenewal ? (
          <>
            <Crest name={t.to_club_name} logo={t.to_club_logo} />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-300">
              {t.to_club_name}
            </span>
            <span className="shrink-0 font-mono text-[10px] font-bold tracking-[0.14em] text-sky-400/80 uppercase">
              Prolongation
            </span>
          </>
        ) : (
          <>
            <Crest name={t.from_club_name} logo={t.from_club_logo} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-400">
              {t.from_club_name ?? "Inconnu"}
            </span>
            <TransferArrow hex={a.hex} />
            <span className="min-w-0 flex-1 truncate text-right text-xs font-semibold text-slate-200">
              {t.to_club_name ?? "Inconnu"}
            </span>
            <Crest name={t.to_club_name} logo={t.to_club_logo} />
          </>
        )}
      </header>

      <div className="flex gap-4 px-4 pt-3">
        <PlayerPortrait
          name={t.player_name}
          cutout={t.player_cutout}
          photo={t.player_photo}
          accent={accent}
        />

        <div className="min-w-0 flex-1 pt-1">
          <h3 className="truncate text-[17px] leading-tight font-extrabold tracking-tight text-slate-100">
            {t.player_name}
            {t.nationality_code && (
              <span className="ml-1.5 align-middle text-sm" aria-label={t.nationality_code}>
                {flagEmoji(t.nationality_code)}
              </span>
            )}
          </h3>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge label={t.status_badge} accent={accent} />

            {/*
              Le marché visé, à côté du statut plutôt qu'en pied de carte : c'est
              la même nature d'information — de quoi situer la rumeur d'un coup
              d'œil — et c'est ce que la barre de filtres découpe. Le championnat
              est préféré au pays quand on l'a, parce qu'il est plus précis et
              tout aussi lisible.
            */}
            {t.to_country_name && (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-[11px] text-slate-500"
                title={t.to_competition ? `${t.to_competition} · ${t.to_country_name}` : undefined}
              >
                {flagEmoji(t.to_country_code) && (
                  <span aria-hidden>{flagEmoji(t.to_country_code)}</span>
                )}
                <span className="truncate">{t.to_competition ?? t.to_country_name}</span>
              </span>
            )}
          </div>

          {amount && (
            <div className="mt-2.5">
              <p
                className={`leading-tight font-extrabold tracking-tight text-slate-50 tabular-nums ${
                  amount.value.length > 10 ? "text-base" : "text-[22px]"
                }`}
              >
                {amount.value}
              </p>
              <p className="mt-0.5 font-mono text-[9px] font-bold tracking-[0.14em] text-slate-500 uppercase">
                {amount.label}
              </p>
            </div>
          )}
        </div>
      </div>

      {t.type === "RUMOUR" ? (
        <div className="mt-3">
          <ProbabilityGauge
            score={t.probability_score}
            previous={t.previous_probability}
            accent={accent}
          />
        </div>
      ) : (
        <div className="h-3" />
      )}

      <footer className="mt-auto flex items-center justify-between gap-3 border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-500">
        <span className="truncate">
          {t.source ?? "Source inconnue"}
          {" · "}
          <time dateTime={t.published_at} suppressHydrationWarning>
            {relativeTime(t.published_at)}
          </time>
        </span>
        {t.source_url && (
          <svg viewBox="0 0 12 12" className="size-3 shrink-0 fill-none stroke-current" aria-hidden>
            <path d="M3.5 8.5l5-5M4.5 3.5h4v4" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        )}
      </footer>
    </>
  );

  // La carte est un enfant direct de la grille : elle doit rester la seule
  // boîte, sinon `align-items: stretch` ne l'atteint plus et les hauteurs de
  // ligne se désalignent. Les classes d'animation arrivent donc par `className`.
  const shell =
    `group flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm transition duration-200 hover:-translate-y-0.5 hover:border-slate-700 focus-visible:-translate-y-0.5 focus-visible:border-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 ${className}`;

  // La carte entière est cliquable quand la source est traçable : sur un produit
  // d'actu, une info qu'on ne peut pas remonter à sa source n'est pas crédible.
  return t.source_url ? (
    <a data-mercato-card href={t.source_url} target="_blank" rel="noopener noreferrer" className={shell}>
      {body}
    </a>
  ) : (
    <article data-mercato-card className={shell}>
      {body}
    </article>
  );
}
