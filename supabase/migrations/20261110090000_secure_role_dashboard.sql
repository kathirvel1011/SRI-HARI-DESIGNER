BEGIN;

REVOKE TRUNCATE ON TABLE
  public.profiles,
  public.designs,
  public.categories,
  public.sub_brands,
  public.activity_logs,
  public.design_views,
  public.favourites
FROM anon, authenticated;

ALTER POLICY "Admins update own designs"
ON public.designs
WITH CHECK (
  (
    uploaded_by = (SELECT auth.uid())
    AND is_admin()
    AND sub_brand_id IS NOT DISTINCT FROM my_sub_brand_id()
  )
  OR is_super_admin()
);

CREATE UNIQUE INDEX profiles_single_super_admin_uq
ON public.profiles (role)
WHERE role = 'super_admin';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'design-images'
      AND public = false
  ) THEN
    RAISE EXCEPTION 'The private design-images bucket is missing or public.';
  END IF;
END;
$$;

UPDATE storage.buckets
SET file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'design-images'
  AND public = false;

COMMIT;
