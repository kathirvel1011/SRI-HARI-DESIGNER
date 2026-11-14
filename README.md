# SRI HARI DESIGNER — Phase 1

This is the first frontend milestone: brand homepage, responsive layout, official uploaded logo, catalogue search/filter interface, About section and contact footer.

## Requirements
- Install Node.js (LTS): https://nodejs.org/
- A GitHub account: https://github.com/

## Run on your computer
1. Extract this ZIP.
2. Open the `sri_hari_designer` folder in Visual Studio Code.
3. Open Terminal → New Terminal.
4. Run:

   ```bash
   npm install
   npm run dev
   ```

5. Open the local URL shown in the terminal (usually http://localhost:5173).

## Publish to GitHub
1. Create a new GitHub repository named `sri-hari-designer`.
2. Upload the extracted project files and folders to the repository.
3. The next milestone will connect the repository to a free hosting service.

## Important project status
The project includes customer and Super Admin dashboards with database-role-based access checks. Historical `admin` profiles and their relationships are preserved, but the frontend no longer provides an Admin dashboard or Admin-account provisioning workflow. The existing `create-admin` Edge Function source is not required by the frontend and must not be deployed for this two-dashboard design. The prepared Super Admin bootstrap script is not executed and must target the existing Auth user's UUID through a controlled database operation.

## Supabase deployment
- Keep `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the local frontend environment. Never place a service-role key in a `VITE_` variable or frontend file.
- Review and apply `supabase/migrations/20261110090000_secure_role_dashboard.sql` to the intended Supabase project. It revokes API-role `TRUNCATE`, tightens admin design sub-brand updates, enforces one Super Admin profile, and sets private image upload limits.
- Review `supabase/migrations/20261111083000_sub_brand_profiles_and_private_logos.sql` before applying. It adds sub-brand contact/address/logo metadata and creates a private logo bucket with Super Admin-only Storage policies. It is not applied automatically.
- Review `supabase/migrations/20261111090000_super_admin_only_design_management.sql` before applying. It adds restrictive RLS policies so only an active Super Admin can write designs or design images; it refuses to proceed unless an active Super Admin profile exists. Confirm that account's access before applying.
- After the Super Admin design-management migration, review and apply `supabase/migrations/20261112100000_design_file_uploads.sql`. It adds `designs.file_assets`, creates or configures the private `design-images` bucket for the supported design MIME types with a 25 MiB per-file limit, and adds published-only SELECT policies for design rows and their attached files. It does not grant customers upload access or expose drafts.
- Review and apply `supabase/migrations/20261113130000_catalogue_interactions.sql` after confirming no duplicate rows exist in `favourites`. It adds an aggregate-only published-design like-count RPC, ensures a unique user/design favourite index without deleting existing rows, and permits reads only for sub-brand logos attached to published designs. Storage buckets remain private and RLS stays enabled.
- Review and apply `supabase/migrations/20261113140000_protect_design_originals.sql` to add the separate private `design-previews` bucket and `designs.preview_path`, remove public original-file read access, restrict original-path columns, and grant authorized original-file metadata through an Admin/Super Admin-only RPC. Existing original objects and paths are preserved; sign in as Super Admin afterward to generate watermarked previews for existing image designs.
- Apply `supabase/migrations/20261113150000_original_file_rpc.sql` after the original-file protection migration. It registers the exact `get_design_original_files(uuid[])` RPC signature, scopes Admin results to their existing uploaded_by/sub-brand permissions, preserves Super Admin access, tightens direct Storage reads to the same scope, grants execution only to authenticated users, and notifies PostgREST to reload its schema cache.
- Original signed URLs issued by older frontend builds may remain usable until their existing expiry (older links were issued for up to one hour); this migration prevents new public signed URLs but cannot retroactively recall URLs already copied by visitors.
- Configure the hosting provider to serve the SPA entry point for `/dashboard`, `/admin/downloads`, `/super-admin`, `/super-admin/designs`, and `/super-admin/add-design` so protected routes work on direct visits and refreshes.
- After applying the migration, review `supabase/bootstrap_super_admin.sql`, replace its UUID placeholder with the existing Auth user's UUID, and run it once in the Supabase SQL Editor. Do not create a second Auth account or put privileged identity details in frontend code or public documentation.

The frontend is not a security boundary: retain Supabase RLS and Storage policies, and do not make the `design-images` bucket public.

## Current business details
- Owner: SOUNDAPPAN R
- Presented by: KATHIRVEL S
- Business / customer contact: 9894046628
- Company location: https://goo.gl/maps/pk33tmDkSBQdMGEA6?g_st=ac

The previous number 9025226305 is not used in this project.
