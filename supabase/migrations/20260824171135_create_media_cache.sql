-- Cache de résolution des visuels.
-- Raison d'être : API-Football plafonne à 100 requêtes/jour. Un club ou un joueur
-- déjà vu ne doit plus jamais coûter d'appel.
create table public.media_cache (
  id               bigint generated always as identity primary key,
  kind             text not null check (kind in ('club', 'player')),
  name_normalized  text not null,        -- minuscule, sans accents ni ponctuation
  af_id            integer,              -- id API-Football, null si non trouvé
  image_url        text,                 -- URL source telle que renvoyée par l'API

  -- Pipeline de détourage (joueurs uniquement)
  cutout_url       text,                 -- URL publique du PNG détouré dans Storage
  cutout_status    text not null default 'pending'
                     check (cutout_status in ('pending','done','failed','skipped')),
  cutout_attempts  smallint not null default 0,

  -- Budget API : évite de re-brûler du quota sur un nom introuvable
  miss_count       smallint not null default 0,
  fetched_at       timestamptz not null default now(),

  unique (kind, name_normalized)
);

comment on table public.media_cache is
  'Cache nom normalisé -> visuel. Écrit uniquement par service_role. Invisible côté client (aucune policy RLS).';
comment on column public.media_cache.cutout_status is
  'skipped = source trop petite (<200px) pour un détourage propre ; le front retombe sur le masque circulaire.';
comment on column public.media_cache.miss_count is
  'Au-delà de 3 échecs de résolution, on n''interroge plus l''API pour ce nom.';

-- File d'attente du worker de détourage
create index media_cache_cutout_queue_idx on public.media_cache (fetched_at)
  where kind = 'player' and cutout_status = 'pending' and cutout_attempts < 3;
