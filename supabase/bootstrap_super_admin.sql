DO $$
DECLARE
  target_user_id uuid := '<existing-auth-user-uuid>'::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users
    WHERE id = target_user_id
  ) THEN
    RAISE EXCEPTION 'The specified Auth user does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = target_user_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'The existing profile is missing or inactive.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role = 'super_admin'
      AND id <> target_user_id
  ) THEN
    RAISE EXCEPTION 'Another Super Admin profile already exists.';
  END IF;

  UPDATE public.profiles
  SET role = 'super_admin'
  WHERE id = target_user_id
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The profile role was not changed.';
  END IF;
END;
$$;
