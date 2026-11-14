BEGIN;

ALTER TABLE public.sub_brands
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS logo_path text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage'
      AND c.relname = 'objects'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must already be enabled on storage.objects before creating private sub-brand logos.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'sub-brand-logos'
  ) THEN
    RAISE EXCEPTION 'The sub-brand-logos bucket already exists; inspect its privacy and policies before reusing it.';
  END IF;
END;
$$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sub-brand-logos',
  'sub-brand-logos',
  false,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'super_admin_read_sub_brand_logos'
  ) THEN
    CREATE POLICY super_admin_read_sub_brand_logos
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (bucket_id = 'sub-brand-logos' AND public.is_super_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'super_admin_insert_sub_brand_logos'
  ) THEN
    CREATE POLICY super_admin_insert_sub_brand_logos
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'sub-brand-logos' AND public.is_super_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'super_admin_update_sub_brand_logos'
  ) THEN
    CREATE POLICY super_admin_update_sub_brand_logos
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (bucket_id = 'sub-brand-logos' AND public.is_super_admin())
      WITH CHECK (bucket_id = 'sub-brand-logos' AND public.is_super_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'super_admin_delete_sub_brand_logos'
  ) THEN
    CREATE POLICY super_admin_delete_sub_brand_logos
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (bucket_id = 'sub-brand-logos' AND public.is_super_admin());
  END IF;
END;
$$;

COMMIT;
