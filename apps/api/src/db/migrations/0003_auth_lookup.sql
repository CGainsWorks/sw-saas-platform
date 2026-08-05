-- 0003_auth_lookup: the one sanctioned way to read membership without a tenant context.
--
-- THE PROBLEM
--
-- At login there is no tenant context yet — establishing which tenants the user may act
-- in is precisely what login is for. But `memberships` is RLS-protected, and correctly
-- so: without it, any tenant could enumerate the users of any other tenant, which is a
-- cross-customer information leak dressed up as a feature.
--
-- So the login path needs to read exactly one thing that the isolation model otherwise
-- forbids, and it needs to do it without handing the application a general bypass.
--
-- THE ANSWER
--
-- A single SECURITY DEFINER function with a deliberately narrow contract: given one
-- email address, return the tenants that address is a member of. Nothing else.
--
-- Why this is safe, and what makes it different from simply granting BYPASSRLS:
--
--   * It answers ONE question. There is no table access, no predicate the caller
--     controls, no way to ask "which users are in tenant X" — the only input is an email
--     and the only output is that email's own memberships.
--   * The email is not attacker-supplied. It comes from an ID token whose signature,
--     issuer, audience, nonce and `email_verified` flag have all been checked against the
--     provider's JWKS (see auth/oidc.ts). A caller who could forge that already has a
--     valid session.
--   * `SET search_path` is pinned. This is the classic SECURITY DEFINER vulnerability: a
--     caller who can create objects in a schema earlier on the search path can shadow
--     `users` or `lower()` with their own version and have it execute as the owner.
--     Pinning the path, plus the REVOKE CREATE in 0002, closes it.
--   * EXECUTE is revoked from PUBLIC and granted only to app_user.
--   * It is STABLE and read-only. It cannot write anything under any input.
--
-- This is the entire RLS escape hatch in the system. It is one function, ~10 lines, and
-- documented in docs/multi_tenancy.md §4. Any future addition here deserves the same
-- level of argument.

CREATE OR REPLACE FUNCTION auth_memberships_for_email(p_email text)
RETURNS TABLE (
    tenant_id   uuid,
    tenant_slug text,
    tenant_name text,
    tenant_plan text,
    user_id     uuid,
    user_name   text,
    role        text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
    SELECT t.id, t.slug, t.name, t.plan, u.id, u.name, m.role
      FROM users u
      JOIN memberships m ON m.user_id = u.id
      JOIN tenants t     ON t.id = m.tenant_id
     WHERE lower(u.email) = lower(p_email)
     ORDER BY t.name;
$$;

COMMENT ON FUNCTION auth_memberships_for_email(text) IS
    'Login-time membership lookup. SECURITY DEFINER so it can read RLS-protected '
    'memberships with no tenant context set. Answers exactly one question, for exactly '
    'one email, read-only. See migration 0003 for the full rationale.';

REVOKE ALL     ON FUNCTION auth_memberships_for_email(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_memberships_for_email(text) TO app_user;
