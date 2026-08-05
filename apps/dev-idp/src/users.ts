/**
 * Demo identities.
 *
 * These exist so the login flow can be exercised without an external identity provider
 * and without anyone typing a password. They line up with the tenants created by
 * apps/api/src/db/seed.ts:
 *
 *   - alice / bob      belong to Acme
 *   - carol            belongs to Globex
 *   - dave             belongs to BOTH, which is what makes tenant switching demonstrable
 *   - erin             belongs to nothing, so logging in as her exercises the self-serve
 *                      provisioning path and creates a fresh tenant
 */
export interface DemoUser {
  sub: string;
  email: string;
  name: string;
  hint: string;
}

export const DEMO_USERS: DemoUser[] = [
  {
    sub: 'dev-idp|alice',
    email: 'alice@acme.test',
    name: 'Alice Nguyen',
    hint: 'Owner of Acme Corp',
  },
  {
    sub: 'dev-idp|bob',
    email: 'bob@acme.test',
    name: 'Bob Ferreira',
    hint: 'Member of Acme Corp — reduced permissions',
  },
  {
    sub: 'dev-idp|carol',
    email: 'carol@globex.test',
    name: 'Carol Baptiste',
    hint: 'Owner of Globex — a completely separate tenant',
  },
  {
    sub: 'dev-idp|dave',
    email: 'dave@globex.test',
    name: 'Dave Okonkwo',
    hint: 'Belongs to BOTH tenants — use this one to try tenant switching',
  },
  {
    sub: 'dev-idp|erin',
    email: 'erin@newco.test',
    name: 'Erin Sandoval',
    hint: 'No membership yet — logging in provisions a brand new tenant',
  },
];

export function findUser(sub: string): DemoUser | undefined {
  return DEMO_USERS.find((u) => u.sub === sub);
}
