BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'designs' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'favourites' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must remain enabled on designs, favourites, and storage.objects.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.favourites'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND ARRAY(
        SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinal)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key_column.attnum
        WHERE key_column.ordinal <= i.indnkeyatts
        ORDER BY key_column.ordinal
      ) IN (
        ARRAY['user_id', 'design_id']::text[],
        ARRAY['design_id', 'user_id']::text[]
      )
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.favourites
      GROUP BY user_id, design_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Duplicate favourites exist; resolve them before adding the per-user design uniqueness constraint.';
    END IF;
    CREATE UNIQUE INDEX favourites_user_design_unique
      ON public.favourites (user_id, design_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_design_favourite_counts(p_design_ids uuid[])
RETURNS TABLE (design_id uuid, like_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT favourite.design_id, pg_catalog.count(*)
  FROM public.favourites AS favourite
  JOIN public.designs AS design ON design.id = favourite.design_id
  WHERE design.is_published IS TRUE
    AND favourite.design_id = ANY (COALESCE(p_design_ids, ARRAY[]::uuid[]))
  GROUP BY favourite.design_id
$function$;

REVOKE ALL ON FUNCTION public.get_design_favourite_counts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_design_favourite_counts(uuid[]) TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'published_design_sub_brand_logos_select'
  ) THEN
    CREATE POLICY published_design_sub_brand_logos_select
      ON storage.objects
      FOR SELECT
      TO anon, authenticated
      USING (
        bucket_id IN ('sub-brand-logos', 'design-images')
        AND EXISTS (
          SELECT 1
          FROM public.designs AS design
          JOIN public.sub_brands AS sub_brand ON sub_brand.id = design.sub_brand_id
          WHERE design.is_published IS TRUE
            AND sub_brand.logo_path = storage.objects.name
        )
      );
  END IF;
END;
$$;

COMMIT;