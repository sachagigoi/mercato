"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

import { FilterBar, type ConnectionStatus } from "@/components/FilterBar";
import { MercatoCard } from "@/components/MercatoCard";
import { MAX_ROWS, maxCreatedAt, mergeRows } from "@/lib/feed";
import { DEFAULT_FILTER, FILTERS, filterOf, type FilterKey } from "@/lib/filters";
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
}: {
  initialRows: Transfer[];
  initialFilter: FilterKey;
}) {
  const [rows, setRows] = useState<Transfer[]>(initialRows);
  const [filter, setFilter] = useState<FilterKey>(initialFilter);
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

  // Le filtre actif vit dans l'URL : un feed filtré doit être partageable.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (filter === DEFAULT_FILTER) url.searchParams.delete("f");
    else url.searchParams.set("f", filter);
    window.history.replaceState(null, "", url);
  }, [filter]);

  const counts = useMemo(() => {
    const out = {} as Record<FilterKey, number>;
    for (const f of FILTERS) out[f.key] = rows.filter(f.match).length;
    return out;
  }, [rows]);

  const active = filterOf(filter);
  const visible = useMemo(() => rows.filter(active.match), [rows, active]);

  return (
    <>
      <FilterBar active={filter} counts={counts} status={status} onChange={setFilter} />

      {visible.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-12 text-center text-sm text-slate-500">
          {active.empty}
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
