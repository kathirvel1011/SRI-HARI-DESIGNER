BEGIN;

ALTER TABLE public.designs
  ADD COLUMN IF NOT EXISTS preview_path text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'designs' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must remain enabled on public.designs and storage.objects.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'designs'
      AND column_name = 'file_assets'
  ) THEN
    RAISE EXCEPTION 'Add the existing designs.file_assets JSONB column before applying this migration.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'design-images') THEN
    RAISE EXCEPTION 'The existing design-images bucket is missing; inspect storage before applying this migration.';
  END IF;
END;
$$;

UPDATE storage.buckets
SET public = false
WHERE id = 'design-images';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('design-previews', 'design-previews', false, 4194304, ARRAY['image/webp', 'image/png'])
ON CONFLICT (id) DO NOTHING;

UPDATE storage.buckets
SET public = false,
    file_size_limit = 4194304,
    allowed_mime_types = ARRAY['image/webp', 'image/png']
WHERE id = 'design-previews';

CREATE OR REPLACE FUNCTION public.is_active_design_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = auth.uid()
      AND profile.is_active IS TRUE
      AND profile.role IN ('admin', 'super_admin')
  )
$function$;

REVOKE ALL ON FUNCTION public.is_active_design_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_design_manager() TO anon, authenticated;

DROP POLICY IF EXISTS published_design_files_select ON storage.objects;

REVOKE SELECT ON public.designs FROM PUBLIC, anon, authenticated;
REVOKE SELECT (image_path, file_assets) ON public.designs FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, serial_number, name, description, keywords, category_id, sub_brand_id,
  preview_path, uploaded_by, is_published, created_at
) ON public.designs TO anon, authenticated;

CREATE POLICY design_manager_designs_select
  ON public.designs
  FOR SELECT
  TO authenticated
  USING (public.is_active_design_manager());

CREATE POLICY design_manager_original_files_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'design-images'
    AND public.is_active_design_manager()
  );

CREATE POLICY design_originals_role_gate
  ON storage.objects
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    bucket_id <> 'design-images'
    OR public.is_active_design_manager()
    OR EXISTS (
      SELECT 1
      FROM public.designs AS design
      JOIN public.sub_brands AS sub_brand ON sub_brand.id = design.sub_brand_id
      WHERE design.is_published IS TRUE
        AND sub_brand.logo_path = storage.objects.name
    )
  );

CREATE POLICY published_design_previews_select
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (
    bucket_id = 'design-previews'
    AND EXISTS (
      SELECT 1 FROM public.designs AS design
      WHERE design.is_published IS TRUE
        AND design.preview_path = storage.objects.name
    )
  );

CREATE POLICY design_manager_previews_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'design-previews'
    AND public.is_active_design_manager()
  );

CREATE POLICY design_preview_role_gate
  ON storage.objects
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    bucket_id <> 'design-previews'
    OR public.is_active_design_manager()
    OR EXISTS (
      SELECT 1 FROM public.designs AS design
      WHERE design.is_published IS TRUE
        AND design.preview_path = storage.objects.name
    )
  );

CREATE POLICY design_preview_insert_gate
  ON storage.objects
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id <> 'design-previews' OR public.is_super_admin());

CREATE POLICY design_preview_update_gate
  ON storage.objects
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (bucket_id <> 'design-previews' OR public.is_super_admin())
  WITH CHECK (bucket_id <> 'design-previews' OR public.is_super_admin());

CREATE POLICY design_preview_delete_gate
  ON storage.objects
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (bucket_id <> 'design-previews' OR public.is_super_admin());

CREATE POLICY super_admin_insert_design_previews
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'design-previews' AND public.is_super_admin());

CREATE POLICY super_admin_update_design_previews
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'design-previews' AND public.is_super_admin())
  WITH CHECK (bucket_id = 'design-previews' AND public.is_super_admin());

CREATE POLICY super_admin_delete_design_previews
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'design-previews' AND public.is_super_admin());

CREATE OR REPLACE FUNCTION public.get_design_original_files(p_design_ids uuid[])
RETURNS TABLE (design_id uuid, name text, path text, type text, size bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_design_manager() THEN
    RAISE EXCEPTION 'An active Admin or Super Admin account is required.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    design.id,
    COALESCE(asset.value ->> 'name', 'design-file'),
    asset.value ->> 'path',
    asset.value ->> 'type',
    NULLIF(asset.value ->> 'size', '')::bigint
  FROM public.designs AS design
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(design.file_assets) = 'array'
      THEN design.file_assets ELSE '[]'::jsonb END
  ) AS asset(value)
  WHERE design.id = ANY (COALESCE(p_design_ids, ARRAY[]::uuid[]))

  UNION ALL

  SELECT
    design.id,
    COALESCE(pg_catalog.regexp_replace(design.image_path, '^.*/', ''), 'design-file'),
    design.image_path,
    NULL::text,
    NULL::bigint
  FROM public.designs AS design
  WHERE design.id = ANY (COALESCE(p_design_ids, ARRAY[]::uuid[]))
    AND design.image_path IS NOT NULL
    AND COALESCE(
      pg_catalog.jsonb_array_length(
        CASE WHEN pg_catalog.jsonb_typeof(design.file_assets) = 'array'
          THEN design.file_assets ELSE '[]'::jsonb END
      ),
      0
    ) = 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_design_original_files(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_design_original_files(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;