BEGIN;

ALTER TABLE public.designs
  ADD COLUMN IF NOT EXISTS file_assets jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'designs'
      AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage'
      AND c.relname = 'objects'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must be enabled on public.designs and storage.objects before applying this migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.designs'::regclass
      AND conname = 'designs_file_assets_array_check'
  ) THEN
    ALTER TABLE public.designs
      ADD CONSTRAINT designs_file_assets_array_check
      CHECK (jsonb_typeof(file_assets) = 'array');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'design-images'
      AND public = true
  ) THEN
    RAISE EXCEPTION 'The design-images bucket is public; make it private before applying this migration.';
  END IF;
END;
$$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('design-images', 'design-images', false, 26214400, NULL)
ON CONFLICT (id) DO NOTHING;

UPDATE storage.buckets
SET file_size_limit = 26214400,
    allowed_mime_types = ARRAY[
      'image/jpeg', 'image/pjpeg', 'image/png', 'image/webp',
      'image/bmp', 'image/x-ms-bmp', 'image/gif', 'image/tiff', 'image/x-tiff',
      'image/svg+xml', 'application/postscript', 'image/eps', 'application/eps',
      'application/pdf', 'application/vnd.corel-draw', 'application/cdr',
      'application/x-cdr', 'image/x-coreldraw', 'image/vnd.adobe.photoshop',
      'image/x-photoshop', 'image/photoshop', 'image/vnd.dxf', 'application/dxf',
      'application/x-dxf', 'image/x-dxf', 'image/vnd.dwg', 'application/acad',
      'application/x-dwg', 'image/x-dwg', 'application/zip',
      'application/x-zip-compressed', 'application/vnd.rar', 'application/x-rar-compressed'
    ]
WHERE id = 'design-images'
  AND public = false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'designs'
      AND policyname = 'published_designs_select'
  ) THEN
    CREATE POLICY published_designs_select
      ON public.designs
      FOR SELECT
      TO anon, authenticated
      USING (is_published = true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'designs'
      AND policyname = 'super_admin_designs_select'
  ) THEN
    CREATE POLICY super_admin_designs_select
      ON public.designs
      FOR SELECT
      TO authenticated
      USING (public.is_super_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'published_design_files_select'
  ) THEN
    CREATE POLICY published_design_files_select
      ON storage.objects
      FOR SELECT
      TO anon, authenticated
      USING (
        bucket_id = 'design-images'
        AND EXISTS (
          SELECT 1
          FROM public.designs AS design
          WHERE design.is_published = true
            AND (
              design.image_path = storage.objects.name
              OR design.file_assets @> jsonb_build_array(jsonb_build_object('path', storage.objects.name))
            )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'super_admin_design_files_select'
  ) THEN
    CREATE POLICY super_admin_design_files_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (bucket_id = 'design-images' AND public.is_super_admin());
  END IF;
END;
$$;

COMMIT;