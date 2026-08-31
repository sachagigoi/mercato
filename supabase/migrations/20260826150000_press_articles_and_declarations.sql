-- Ce que la presse dit, avant qu'on décide ce que ça vaut.
--
-- Deux tables, et une frontière assumée entre elles et `transfers` :
-- `transfers` porte l'état COURANT d'une piste, celui qu'affiche le feed ;
-- `declarations` porte les OBSERVATIONS qui l'ont fait bouger, une par
-- source et par passage. La première s'écrase, la seconde s'empile.
--
-- La séparation est ce qui rend le produit défendable : quand une carte
-- affiche « 50 M€ », on peut montrer l'article, la phrase, le modèle et la
-- version de consigne qui l'ont produite. Un seul champ écrasé au fil des
-- sources ne saurait rien répondre.

-- Vocabulaires fermés, en miroir de lib/extract/claims.ts.
-- Un enum plutôt qu'un check : la valeur illégale est refusée à l'écriture,
-- et `alter type ... add value` reste possible le jour où la presse invente
-- une nuance de plus.
create type public.claim_stance   as enum ('rumeur', 'discussions', 'accord', 'officiel', 'dementi');
create type public.claim_fee_kind as enum ('transfert', 'pret', 'pret_avec_option', 'clause', 'libre', 'inconnu');
create type public.claim_qualifier as enum ('exact', 'environ', 'minimum', 'maximum');

-- L'article, comme fait du monde. Aucune trace de pipeline ici : le modèle et
-- la version de consigne appartiennent à l'extraction, pas à la brève.
-- C'est ce qui permet de rejouer un même corpus avec un autre modèle sans
-- toucher à la provenance.
create table public.press_articles (
  id                uuid primary key default gen_random_uuid(),

  source            text not null,                    -- 'Maxifoot'
  -- Rang de confiance de la source (1 = journaliste attitré, 3 = agrégateur).
  -- Stocké sur l'article et non déduit à la lecture : le rang d'une source
  -- peut changer, ce qu'elle valait le jour de la publication, non.
  source_tier       smallint not null default 3 check (source_tier between 1 and 3),

  guid              text not null unique,             -- clé naturelle du flux
  url               text not null,
  title             text not null,

  published_at      timestamptz not null,
  first_seen_at     timestamptz not null default now(),
  last_extracted_at timestamptz not null default now()
);

comment on table public.press_articles is
  'Brèves de presse traitées. `guid` est la clé de dédoublonnage du flux.';

-- La déclaration : ce qu'UNE source dit d'UN transfert, à un moment donné.
--
-- Append-only. Rien ici ne se corrige : une information démentie ne s'efface
-- pas, elle est suivie d'une déclaration de posture `dementi`. C'est la seule
-- façon d'expliquer plus tard pourquoi un montant a bougé.
create table public.declarations (
  id                uuid primary key default gen_random_uuid(),

  -- Idempotence. Calculée côté code (lib/declarations.ts), comme
  -- `transfers.external_id` : le dédoublonnage se teste alors sans base.
  -- Le modèle et la version de consigne en font partie — rejouer un article
  -- avec un autre modèle doit produire une NOUVELLE ligne, comparable à
  -- l'ancienne, pas l'écraser.
  claim_key         text not null unique,

  article_id        uuid not null references public.press_articles(id) on delete cascade,
  -- Piste enrichie par cette déclaration. Nul tant que le rapprochement n'a
  -- pas eu lieu : une déclaration existe indépendamment de ce qu'elle enrichit,
  -- et peut arriver avant la rumeur qu'elle concerne.
  transfer_id       uuid references public.transfers(id) on delete set null,

  player_name       text not null,
  player_normalized text not null,                    -- forme de rapprochement

  -- Le libellé brut ET la clé résolue. Le libellé sert à afficher et à
  -- rejouer une résolution ratée ; la clé sert à joindre. Perdre le brut
  -- rendrait toute correction du référentiel inapplicable au passé.
  from_club_name    text,
  from_club_key     text,                             -- tmId, ou nul si hors L1
  to_club_name      text,
  to_club_key       text,

  fee_eur           bigint,
  fee_label         text,                             -- '50 M€', tel qu'affiché
  fee_kind          public.claim_fee_kind not null default 'inconnu',
  qualifier         public.claim_qualifier not null default 'exact',
  bonus_eur         bigint,
  stance            public.claim_stance not null default 'rumeur',

  -- La preuve. Phrase reprise telle quelle de l'article, jamais reformulée
  -- par le modèle : c'est ce qui permet d'afficher un montant sans demander
  -- au lecteur de nous croire sur parole.
  quote             text not null,
  fee_quote         text,
  player_in_quote   boolean not null default false,

  model             text not null,
  prompt_version    text not null,

  published_at      timestamptz not null,             -- date de l'article
  created_at        timestamptz not null default now()
);

comment on table public.declarations is
  'Observations de presse, append-only. Une ligne par transfert évoqué, par article et par passage d''extraction.';
comment on column public.declarations.claim_key is
  'Clé naturelle de dédoublonnage, calculée par lib/declarations.ts. Cible du ON CONFLICT.';
comment on column public.declarations.transfer_id is
  'Piste enrichie. Nul jusqu''au rapprochement ; une déclaration peut précéder la rumeur.';

-- La file du rapprochement : ce qui n'a pas encore trouvé sa piste.
create index declarations_pending_idx on public.declarations (published_at desc)
  where transfer_id is null;
-- Le rapprochement lui-même, qui part du nom du joueur.
create index declarations_player_idx on public.declarations (player_normalized, published_at desc);
-- Les déclarations d'une piste, pour l'historique affiché sur la carte.
create index declarations_transfer_idx on public.declarations (transfer_id, published_at desc)
  where transfer_id is not null;
create index declarations_article_idx on public.declarations (article_id);

-- Aucune policy : les deux tables sont invisibles côté client, seul
-- service_role écrit et lit. Volontaire — elles portent de la matière de
-- travail, pas du contenu publiable. Le feed lit `transfers`, qui reste la
-- seule table exposée.
alter table public.press_articles enable row level security;
alter table public.declarations   enable row level security;
