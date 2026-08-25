"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

import { FilterBar, type ConnectionStatus } from "@/components/FilterBar";
import { MercatoCard } from "@/components/MercatoCard";
import { MAX_ROWS, maxCreatedAt, mergeRows } from "@/lib/feed";
import {
  ALL_COUNTRIES,
  countryOptions,
  DEFAULT_FILTER,
  FILTERS,
  filterOf,
  matchesCountry,
  type FilterKey,
} from "@/lib/filters";
import { getBrowserClient } from "@/lib/supabase/client";
import type { Transfer } from "@/lib/types";

/** Durée du surlignage d'une carte entrante ou modifiée. */
const HIGHLIGHT_MS = 1500;
/** Cadence du repli quand l'abonnement Realtime est indisponible (§10 des specs). */
const POLL_MS = 60_000;
/** Au-delà, on considère l'abonnement perdu et on bascule sur le repli. */
const CONNECT_TIMEOUT_MS = 10_000;

type Highlight = "in" | "pulse";

export function MercatoFeed({
  initialRows,
  initialFilter,
  initialCountry,
}: {
  initialRows: Transfer[];
  initialFilter: FilterKey;
  initialCountry: string;
}) {
  const [rows, setRows] = useState<Transfer[]>(initialRows);
  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [country, setCountry] = useState<string>(initialCountry);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [highlights, setHighlights] = useState<ReadonlyMap<string, Highlight>>(new Map());

  // Repère de rattrapage : borne haute des `created_at` déjà vus.
  const watermark = useRef(maxCreatedAt(initialRows));
  // Miroir de `rows`, pour distinguer un INSERT d'un UPDATE hors du cycle de rendu.
  const knownIds = useRef(new Set(initialRows.map((r) => r.id)));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const highlight = useCallback((id: string, kind: Highlight) => {
    setHighlights((prev) => new Map(prev).set(id, kind));
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setHighlights((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }, HIGHLIGHT_MS),
    );
  }, []);

  const absorb = useCallback((incoming: Transfer[], removeId?: string) => {
    for (const row of incoming) {
      if (Date.parse(row.created_at) > Date.parse(watermark.current)) {
        watermark.current = row.created_at;
      }
      // Marqué connu tout de suite, pas au prochain rendu : un même INSERT rejoué
      // dans le même tick serait sinon compté deux fois comme nouveau et
      // rejouerait l'animation d'entrée.
      knownIds.current.add(row.id);
    }
    setRows((prev) => {
      const next = mergeRows(prev, incoming, removeId);
      knownIds.current = new Set(next.map((r) => r.id));
      return next;
    });
  }, []);

  /**
   * Rattrapage de la fenêtre de course.
   *
   * Entre le rendu serveur et le passage à SUBSCRIBED, aucune insertion n'est
   * notifiée : ces lignes seraient perdues définitivement. On les redemande à
   * chaque (ré)abonnement — ce qui couvre aussi la reprise après coupure.
   */
  const catchUp = useCallback(async () => {
    const { data, error } = await getBrowserClient()
      .from("transfers")
      .select("*")
      .gt("created_at", watermark.current)
      .order("published_at", { ascending: false })
      .limit(MAX_ROWS);

    if (error || !data?.length) return;
    const fresh = data.filter((r) => !knownIds.current.has(r.id));
    absorb(data);
    for (const row of fresh) highlight(row.id, "in");
  }, [absorb, highlight]);

  /** Repli sans Realtime : relecture complète, qui rattrape aussi les UPDATE. */
  const refetchAll = useCallback(async () => {
    const { data, error } = await getBrowserClient()
      .from("transfers")
      .select("*")
      .order("published_at", { ascending: false })
      .limit(MAX_ROWS);

    if (error || !data) return;
    absorb(data);
  }, [absorb]);

  const onChange = useCallback(
    (payload: RealtimePostgresChangesPayload<Transfer>) => {
      if (payload.eventType === "DELETE") {
        const id = (payload.old as Partial<Transfer> | null)?.id;
        if (id) absorb([], id);
        return;
      }

      const row = payload.new as Transfer | null;
      if (!row?.id) return;

      const isNew = !knownIds.current.has(row.id);
      absorb([row]);
      highlight(row.id, isNew ? "in" : "pulse");
    },
    [absorb, highlight],
  );

  useEffect(() => {
    const supabase = getBrowserClient();

    // Garde-fou : un abonnement peut rester en attente indéfiniment sans jamais
    // émettre CHANNEL_ERROR — c'est ce qui arrive quand la WebSocket n'aboutit
    // pas (réseau qui l'interdit, proxy qui ne la relaie pas). Sans ce délai,
    // le feed resterait figé sur « Connexion » et le repli ne partirait jamais.
    const watchdog = setTimeout(() => {
      setStatus((current) => (current === "connecting" ? "polling" : current));
    }, CONNECT_TIMEOUT_MS);

    const channel = supabase
      .channel("transfers-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "transfers" }, onChange)
      .subscribe((state) => {
        if (state === "SUBSCRIBED") {
          clearTimeout(watchdog);
          setStatus("live");
          void catchUp();
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          clearTimeout(watchdog);
          setStatus("polling");
        }
      });

    return () => {
      clearTimeout(watchdog);
      void supabase.removeChannel(channel);
    };
  }, [catchUp, onChange]);

  useEffect(() => {
    if (status !== "polling") return;
    const id = setInterval(() => void refetchAll(), POLL_MS);
    return () => clearInterval(id);
  }, [status, refetchAll]);

  // Purge des minuteurs de surlignage encore en vol au démontage.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  // Les filtres actifs vivent dans l'URL : un feed filtré doit être partageable,
  // et « les rumeurs chaudes en Ligue 1 » est justement le genre de lien qu'on
  // envoie à quelqu'un.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (filter === DEFAULT_FILTER) url.searchParams.delete("f");
    else url.searchParams.set("f", filter);
    if (country === ALL_COUNTRIES) url.searchParams.delete("p");
    else url.searchParams.set("p", country);
    window.history.replaceState(null, "", url);
  }, [filter, country]);

  const active = filterOf(filter);

  // Chaque axe est compté DANS l'autre : les types sont comptés sur le pays
  // choisi, les pays sur le type choisi. C'est la même règle que pour les
  // compteurs d'origine — le nombre affiché doit être exactement ce que le clic
  // va montrer. Compter chaque axe sur le jeu entier donnerait des puces qui
  // annoncent douze cartes et n'en ouvrent aucune.
  const inCountry = useMemo(
    () => rows.filter((t) => matchesCountry(t, country)),
    [rows, country],
  );
  const inType = useMemo(() => rows.filter(active.match), [rows, active]);

  const counts = useMemo(() => {
    const out = {} as Record<FilterKey, number>;
    for (const f of FILTERS) out[f.key] = inCountry.filter(f.match).length;
    return out;
  }, [inCountry]);

  // La liste des puces vient du feed entier, les comptes du type sélectionné :
  // sans quoi la puce active s'évanouirait au premier changement d'onglet.
  const countries = useMemo(() => countryOptions(rows, inType), [rows, inType]);

  // Une puce vide ne mène nulle part et n'a rien à faire dans la rangée — sauf
  // celle qui est sélectionnée, qui doit rester visible pour qu'on puisse la
  // désélectionner et pour que le message d'état vide sache de quel pays il parle.
  const visibleCountries = useMemo(
    () => countries.filter((c) => c.count > 0 || c.key === country),
    [countries, country],
  );

  // null quand la clé ne désigne aucun pays du feed : une URL bricolée, ou un
  // championnat sorti des dernières lignes chargées.
  const activeCountryLabel = countries.find((c) => c.key === country)?.label ?? null;

  const visible = useMemo(
    () => inType.filter((t) => matchesCountry(t, country)),
    [inType, country],
  );

  // Un pays peut quitter le feed pendant qu'il est sélectionné : une rumeur
  // dépubliée, ou le seul club polonais qui sort des dernières lignes chargées.
  // Une clé venue d'une URL bricolée tombe dans le même cas. Sans ce retour, le
  // lecteur resterait devant une grille vide, sans puce active à quoi la
  // rattacher. Le test porte bien sur `countries`, dérivé du feed entier, et non
  // sur les puces affichées : un pays simplement absent du type sélectionné est
  // une sélection légitime, pas une impasse.
  useEffect(() => {
    if (country === ALL_COUNTRIES) return;
    if (!countries.some((c) => c.key === country)) setCountry(ALL_COUNTRIES);
  }, [countries, country]);

  return (
    <>
      <FilterBar
        active={filter}
        counts={counts}
        countries={visibleCountries}
        activeCountry={country}
        status={status}
        onChange={setFilter}
        onCountryChange={setCountry}
      />

      {visible.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-12 text-center text-sm text-slate-500">
          {/*
            Le message du filtre de type ne suffit plus dès qu'un pays est
            choisi : « Aucune rumeur au-dessus de 70 % » laisserait croire que
            le feed entier est froid, alors que seule l'Espagne l'est.
          */}
          {country === ALL_COUNTRIES || !activeCountryLabel
            ? active.empty
            : `Rien à afficher pour « ${activeCountryLabel} » dans cette catégorie.`}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => {
            const kind = highlights.get(t.id);
            return (
              <MercatoCard
                key={t.id}
                transfer={t}
                className={kind === "in" ? "card-in" : kind === "pulse" ? "card-pulse" : ""}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
