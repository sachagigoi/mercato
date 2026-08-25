-- Valeur de marché du joueur, et marché visé par la rumeur.
--
-- La page des rumeurs de Transfermarkt n'affiche aucun montant : sept colonnes,
-- joueur, âge, nationalité, club actuel, club intéressé, date, probabilité. Et
-- pour cause — une rumeur n'a pas de prix négocié, le prix n'existe qu'une fois
-- l'accord trouvé. Le seul chiffre honnête à ce stade est la valeur de marché
-- du joueur, publiée sur sa fiche.
--
-- Elle est stockée à part de `transfer_fee` plutôt qu'écrite dedans : une
-- estimation et un prix convenu ne disent pas la même chose, et la carte doit
-- pouvoir annoncer lequel des deux elle montre. Les confondre serait mentir au
-- lecteur d'un produit d'actualité.
alter table public.transfers
  add column tm_player_id            text,
  add column market_value_eur        bigint,
  add column market_value_label      text,
  add column market_value_fetched_at timestamptz,
  add column to_country_code         text,
  add column to_country_name         text,
  add column to_competition          text;

comment on column public.transfers.tm_player_id is
  'Identifiant Transfermarkt du joueur. Clé de regroupement de la résolution des valeurs : un joueur cité dans trois rumeurs ne coûte qu''une requête.';
comment on column public.transfers.market_value_eur is
  'Valeur de marché estimée, en euros. À ne pas confondre avec fee_value_eur, qui est un prix de transfert convenu.';
comment on column public.transfers.market_value_label is
  'Libellé d''affichage francisé à l''ingestion : « 220 M€ ». Même règle que transfer_fee, la carte l''affiche tel quel.';
comment on column public.transfers.market_value_fetched_at is
  'Date de la dernière lecture de la fiche joueur. null = jamais lue. Sert de file d''attente et de repère de péremption.';
comment on column public.transfers.to_country_code is
  'Code drapeau du pays du club acheteur, dérivé du championnat : ISO 3166-1 alpha-2 minuscule (« pl »), ou subdivision pour les nations britanniques (« gb-eng »). null quand le pays n''est pas dans la table de correspondance.';
comment on column public.transfers.to_country_name is
  'Nom du pays, déjà francisé à l''ingestion. Toujours renseigné quand la source donne un championnat, même sans code ISO.';
comment on column public.transfers.to_competition is
  'Championnat du club acheteur, tel que nommé par la source : « Premier League », « Ekstraklasa ».';

-- File d'attente de la résolution des valeurs : les joueurs jamais lus d'abord,
-- puis les plus anciens. `nulls first` est explicite plutôt que subi — c'est
-- l'ordre de traitement voulu, pas un effet de bord du tri croissant.
create index transfers_market_value_queue_idx
  on public.transfers (market_value_fetched_at nulls first)
  where tm_player_id is not null;

-- Filtre pays de la barre, même forme que les index de tri du feed (§2.3) :
-- partiel sur is_published, et le tri du feed embarqué dans l'index.
create index transfers_country_idx
  on public.transfers (to_country_code, published_at desc)
  where is_published;
