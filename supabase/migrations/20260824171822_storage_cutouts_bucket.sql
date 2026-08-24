-- Bucket public des portraits détourés produits par le worker.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cutouts', 'cutouts', true, 524288, array['image/png','image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Lecture publique du bucket. L'écriture reste réservée à service_role,
-- qui contourne RLS : aucune policy insert/update/delete n'est créée.
create policy "cutouts_public_read"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'cutouts');
