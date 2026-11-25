import { describe, expect, it } from 'vitest';

import { referencedRoles } from '../../src/backup';

describe('referencedRoles', () => {
  it('finds owners, grantees, grantors, default-privilege owners and policy roles', () => {
    const script = [
      'ALTER SCHEMA app OWNER TO neondb_owner;',
      'ALTER TABLE public.projects OWNER TO neondb_owner;',
      'ALTER FUNCTION app.provision_personal_workspace() OWNER TO bahith_identity_provisioner;',
      'GRANT SELECT,INSERT ON TABLE public.projects TO bahith_app;',
      'GRANT ALL ON TABLE public.projects TO neon_superuser WITH GRANT OPTION;',
      'GRANT USAGE ON SCHEMA app TO bahith_app, bahith_auth;',
      'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
      'GRANT SELECT ON TABLE public.plans TO "Odd ""Role""" GRANTED BY grantor_role;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT ALL ON TABLES TO neon_superuser;',
      'CREATE POLICY tenant ON public.projects TO bahith_app USING ((workspace_id = app.current_workspace()));',
      "COMMENT ON TABLE public.projects IS 'GRANT nothing TO nobody';",
      "SET default_tablespace = '';",
    ].join('\n');
    expect(referencedRoles(script)).toEqual(
      [
        'Odd "Role"',
        'bahith_app',
        'bahith_auth',
        'bahith_identity_provisioner',
        'grantor_role',
        'neon_superuser',
        'neondb_owner',
      ].sort(),
    );
  });

  it('returns nothing for a script without roles', () => {
    expect(referencedRoles('CREATE TABLE public.t (id integer);\nSELECT 1;')).toEqual([]);
  });
});
