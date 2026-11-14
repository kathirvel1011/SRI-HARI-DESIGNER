BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'designs'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must already be enabled on public.designs.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage'
      AND c.relname = 'objects'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must already be enabled on storage.objects.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role = 'super_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No active Super Admin profile exists; refusing to restrict design management until access is verified.';
  END IF;
END;
$$;

CREATE POLICY super_admin_only_design_insert
  ON public.designs
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY super_admin_only_design_update
  ON public.designs
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

CREATE POLICY super_admin_only_design_delete
  ON public.designs
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (public.is_super_admin());

CREATE POLICY super_admin_only_design_image_insert
  ON storage.objects
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id <> 'design-images' OR public.is_super_admin());

CREATE POLICY super_admin_only_design_image_update
  ON storage.objects
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (bucket_id <> 'design-images' OR public.is_super_admin())
  WITH CHECK (bucket_id <> 'design-images' OR public.is_super_admin());

CREATE POLICY super_admin_only_design_image_delete
  ON storage.objects
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (bucket_id <> 'design-images' OR public.is_super_admin());

COMMIT;
