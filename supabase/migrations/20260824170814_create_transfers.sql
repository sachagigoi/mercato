-- Type d'actualité mercato
create type public.transfer_type as enum ('TRANSFER', 'RUMOUR', 'EXTENSION');

create table public.transfers (
  id                   uuid primary key default gen_random_uuid(),

  -- Identité / idempotence : clé naturelle de la source.
  -- Format : 'tm:rumour:{tm_player_id}:{tm_to_club_id}' ou 'manual:{slug}'.
  external_id          text not null unique,

  -- Joueur
  player_name          text not null,
  player_photo         text,              -- URL source (API-Football / Transfermarkt)
  player_cutout        text,              -- URL Supabase Storage du PNG détouré
  nationality_code     text,              -- ISO 3166-1 alpha-2 minuscule ('fr', 'br')

  -- Clubs
  from_club_name       text,
  from_club_logo       text,
  to_club_name         text,
  to_club_logo         text,

  -- Deal
  transfer_fee         text,              -- libellé d'affichage : '45 M€', 'Prêt', 'Libre'
  fee_value_eur        bigint,            -- valeur numérique ; tri et filtres
  type                 public.transfer_type not null,
  probability_score    smallint check (probability_score between 0 and 100),
  previous_probability smallint check (previous_probability between 0 and 100),
  status_badge         text,              -- libellé d'affichage uniquement (couleur dérivée)

  -- Provenance
  source               text,
  source_url           text,

  -- Modération / temps
  is_published         boolean not null default true,
  published_at         timestamptz not null default now(),  -- date de l'info
  created_at           timestamptz not null default now(),  -- date d'insertion
  updated_at           timestamptz not null default now()
);

comment on column public.transfers.external_id is
  'Clé naturelle de dédoublonnage. Cible du ON CONFLICT à l''ingestion.';
comment on column public.transfers.published_at is
  'Date de l''info. Tri du feed. Distincte de created_at pour qu''un backfill ne remonte pas en tête.';
comment on column public.transfers.previous_probability is
  'Valeur précédente de probability_score, écrite à l''upsert. Alimente la flèche de tendance.';

-- updated_at automatique
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger transfers_touch_updated_at
  before update on public.transfers
  for each row execute function public.touch_updated_at();

-- Index alignés sur les 4 filtres de la barre du feed
create index transfers_feed_idx on public.transfers (published_at desc) where is_published;
create index transfers_type_idx on public.transfers (type, published_at desc) where is_published;
create index transfers_hot_idx  on public.transfers (probability_score desc)
  where is_published and type = 'RUMOUR';
