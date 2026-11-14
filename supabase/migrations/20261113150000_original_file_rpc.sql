BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'designs'
      AND column_name = 'file_assets'
      AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'Expected public.designs.file_assets JSONB column is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'designs'
      AND column_name = 'uploaded_by'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'designs'
      AND column_name = 'sub_brand_id'
  ) THEN
    RAISE EXCEPTION 'Expected designs.uploaded_by or designs.sub_brand_id column is missing.';
  END IF;

  IF to_regprocedure('public.is_admin()') IS NULL
    OR to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regprocedure('public.my_sub_brand_id()') IS NULL THEN
    RAISE EXCEPTION 'Expected existing Admin, Super Admin, or sub-brand permission functions are missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'designs' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must remain enabled on profiles, designs, and storage.objects.';
  END IF;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.get_design_original_files(p_design_ids uuid[])
RETURNS TABLE (design_id uuid, name text, path text, type text, size bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id = auth.uid()
        AND profile.is_active IS TRUE
        AND profile.role IN ('admin', 'super_admin')
    )
    OR NOT (public.is_admin() OR public.is_super_admin()) THEN
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
    AND asset.value ->> 'path' IS NOT NULL
    AND (
      public.is_super_admin()
      OR (
        public.is_admin()
        AND design.uploaded_by = auth.uid()
        AND design.sub_brand_id IS NOT DISTINCT FROM public.my_sub_brand_id()
      )
    )

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
    ) = 0
    AND (
      public.is_super_admin()
      OR (
        public.is_admin()
        AND design.uploaded_by = auth.uid()
        AND design.sub_brand_id IS NOT DISTINCT FROM public.my_sub_brand_id()
      )
    );
END;
$function$;

DROP POLICY IF EXISTS design_manager_original_files_select ON storage.objects;
DROP POLICY IF EXISTS design_originals_role_gate ON storage.objects;

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
    OR (
      public.is_active_design_manager()
      AND public.is_super_admin()
    )
    OR (
      auth.uid() IS NOT NULL
      AND public.is_active_design_manager()
      AND public.is_admin()
      AND EXISTS (
        SELECT 1
        FROM public.designs AS design
        WHERE design.uploaded_by = auth.uid()
          AND design.sub_brand_id IS NOT DISTINCT FROM public.my_sub_brand_id()
          AND (
            design.image_path = storage.objects.name
            OR design.file_assets @> pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object('path', storage.objects.name)
            )
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM public.designs AS design
      JOIN public.sub_brands AS sub_brand ON sub_brand.id = design.sub_brand_id
      WHERE design.is_published IS TRUE
        AND sub_brand.logo_path = storage.objects.name
    )
  );

REVOKE ALL ON FUNCTION public.get_design_original_files(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_design_original_files(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
