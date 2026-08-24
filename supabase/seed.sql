-- SEED DE DÉVELOPPEMENT — données fictives, non factuelles.
--
-- Trois règles tenues ici :
--   1. external_id préfixé 'manual:' : aucune collision possible avec l'ingestion réelle.
--   2. `source` volontairement neutre : aucune rumeur inventée n'est attribuée à un
--      journaliste ou un média réel. Seule l'ingestion réelle porte une vraie attribution.
--   3. player_photo laissé NULL : les vrais portraits arrivent avec le pipeline de Phase 4.
--      Le seed exerce donc en permanence le fallback silhouette prévu au §04.
--
-- Couverture voulue : les 3 types, probabilités étalées 5 -> 96, tendances montantes et
-- descendantes, montants chiffrés + 'Libre' + 'Prêt' + '—', et 8 lignes sans logo de club
-- pour que le fallback initiales soit visible dès le premier écran.

insert into public.transfers
  (external_id, player_name, nationality_code,
   from_club_name, from_club_logo, to_club_name, to_club_logo,
   transfer_fee, fee_value_eur, type, probability_score, previous_probability,
   status_badge, source, published_at)
values
  ('manual:001','Rayan Cherki','fr','Olympique Lyonnais','https://media.api-sports.io/football/teams/80.png','Paris Saint-Germain','https://media.api-sports.io/football/teams/85.png','45 M€',45000000,'RUMOUR',78,66,'Piste chaude','Démo — donnée fictive',now() - interval '2 hours'),
  ('manual:002','Lucas Bergeron','fr','Stade Rennais','https://media.api-sports.io/football/teams/94.png','Arsenal','https://media.api-sports.io/football/teams/42.png','32 M€',32000000,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '5 hours'),
  ('manual:003','Matteo Ferrara','it','Juventus','https://media.api-sports.io/football/teams/496.png','Juventus','https://media.api-sports.io/football/teams/496.png','—',null,'EXTENSION',100,null,'Prolongation jusqu''en 2029','Démo — donnée fictive',now() - interval '7 hours'),
  ('manual:004','Diego Salvatierra','ar','River Plate',null,'Atlético Madrid','https://media.api-sports.io/football/teams/530.png','18 M€',18000000,'RUMOUR',54,54,'Négociations en cours','Démo — donnée fictive',now() - interval '9 hours'),
  ('manual:005','Kwame Asante','en','Chelsea','https://media.api-sports.io/football/teams/49.png','Bayer Leverkusen',null,'Prêt',null,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '11 hours'),
  ('manual:006','Youssef El Amrani','ma','AS Roma',null,'Olympique de Marseille','https://media.api-sports.io/football/teams/81.png','12 M€',12000000,'RUMOUR',41,29,'Contact établi','Démo — donnée fictive',now() - interval '14 hours'),
  ('manual:007','Viktor Lindholm','no','Rosenborg',null,'Ajax','https://media.api-sports.io/football/teams/194.png','7,5 M€',7500000,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '17 hours'),
  ('manual:008','Bruno Cardoso','pt','SL Benfica','https://media.api-sports.io/football/teams/211.png','Manchester City','https://media.api-sports.io/football/teams/50.png','82 M€',82000000,'RUMOUR',91,84,'Accord imminent','Démo — donnée fictive',now() - interval '20 hours'),
  ('manual:009','Ismaël Diarra','sn','FC Nantes',null,'OGC Nice','https://media.api-sports.io/football/teams/84.png','Libre',0,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '23 hours'),
  ('manual:010','Tomas Havelka','hr','Dinamo Zagreb',null,'Inter','https://media.api-sports.io/football/teams/505.png','9 M€',9000000,'RUMOUR',23,31,'Piste explorée','Démo — donnée fictive',now() - interval '1 day 3 hours'),
  ('manual:011','Erik Sørensen','no','Borussia Dortmund','https://media.api-sports.io/football/teams/165.png','Borussia Dortmund','https://media.api-sports.io/football/teams/165.png','—',null,'EXTENSION',100,null,'Prolongation jusqu''en 2030','Démo — donnée fictive',now() - interval '1 day 6 hours'),
  ('manual:012','Rafael Moreira','br','Santos',null,'FC Porto',null,'21 M€',21000000,'RUMOUR',68,52,'Offre transmise','Démo — donnée fictive',now() - interval '1 day 9 hours'),
  ('manual:013','Jonas Weber','de','VfB Stuttgart',null,'Bayern Munich','https://media.api-sports.io/football/teams/157.png','55 M€',55000000,'RUMOUR',87,87,'Accord trouvé','Démo — donnée fictive',now() - interval '1 day 12 hours'),
  ('manual:014','Adam Kowalski','pl','Legia Varsovie',null,'Feyenoord',null,'Prêt',null,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '1 day 16 hours'),
  ('manual:015','Nicolas Vermeulen','be','Club Bruges',null,'Tottenham','https://media.api-sports.io/football/teams/47.png','28 M€',28000000,'RUMOUR',73,61,'Piste chaude','Démo — donnée fictive',now() - interval '1 day 20 hours'),
  ('manual:016','Karim Benali','fr','LOSC Lille','https://media.api-sports.io/football/teams/79.png','LOSC Lille','https://media.api-sports.io/football/teams/79.png','—',null,'EXTENSION',100,null,'Prolongation jusqu''en 2028','Démo — donnée fictive',now() - interval '2 days 2 hours'),
  ('manual:017','Gabriel Nogueira','br','Flamengo',null,'Liverpool','https://media.api-sports.io/football/teams/40.png','64 M€',64000000,'RUMOUR',96,88,'Visite médicale programmée','Démo — donnée fictive',now() - interval '2 days 5 hours'),
  ('manual:018','Ahmed Farouk','eg','Al Ahly',null,'FC Bâle',null,'3,2 M€',3200000,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '2 days 9 hours'),
  ('manual:019','Sergio Delgado','es','Real Betis',null,'FC Barcelone','https://media.api-sports.io/football/teams/529.png','Libre',0,'RUMOUR',35,35,'Dossier ouvert','Démo — donnée fictive',now() - interval '2 days 14 hours'),
  ('manual:020','Lars van Dijk','nl','PSV Eindhoven',null,'Newcastle',null,'37 M€',37000000,'RUMOUR',12,26,'Piste refroidie','Démo — donnée fictive',now() - interval '2 days 19 hours'),
  ('manual:021','Facundo Ríos','uy','Peñarol',null,'AC Milan','https://media.api-sports.io/football/teams/489.png','15 M€',15000000,'TRANSFER',100,null,'Officialisé','Démo — donnée fictive',now() - interval '3 days 4 hours'),
  ('manual:022','Thomas Aubert','fr','AS Monaco','https://media.api-sports.io/football/teams/91.png','Manchester United','https://media.api-sports.io/football/teams/33.png','48 M€',48000000,'RUMOUR',5,18,'Démenti du club','Démo — donnée fictive',now() - interval '3 days 11 hours'),
  ('manual:023','Mateo Fernández','es','Real Madrid','https://media.api-sports.io/football/teams/541.png','Real Madrid','https://media.api-sports.io/football/teams/541.png','—',null,'EXTENSION',100,null,'Prolongation jusqu''en 2031','Démo — donnée fictive',now() - interval '4 days 2 hours'),
  ('manual:024','Idrissa Camara','sn','RC Lens',null,'SSC Naples','https://media.api-sports.io/football/teams/492.png','Prêt avec option',null,'RUMOUR',62,49,'Discussions avancées','Démo — donnée fictive',now() - interval '4 days 18 hours')
on conflict (external_id) do nothing;
