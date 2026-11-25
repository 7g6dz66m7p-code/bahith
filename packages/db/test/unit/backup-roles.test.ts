import { describe, expect, it } from 'vitest';

import { referencedRoles, requiredExtensions, restoreList } from '../../src/backup';

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

describe('restoreList', () => {
  const toc = [
    ';',
    '; Archive created at 2026-11-25 16:57:47 UTC',
    ';',
    '3; 3079 16390 EXTENSION - pg_session_jwt ',
    '4571; 0 0 COMMENT - EXTENSION pg_session_jwt ',
    '2; 3079 16400 EXTENSION - vector ',
    '4572; 0 0 COMMENT - EXTENSION vector ',
    '230; 1259 16500 TABLE public projects neondb_owner',
  ].join('\n');

  it('drops an unavailable extension BAHITH does not need, with its comment', () => {
    const { list, skipped } = restoreList(toc, new Set(['vector', 'plpgsql']), new Set(['vector']));
    expect(skipped).toEqual(['pg_session_jwt']);
    expect(list).not.toContain('pg_session_jwt');
    expect(list).toContain('EXTENSION - vector');
    expect(list).toContain('COMMENT - EXTENSION vector');
    expect(list).toContain('TABLE public projects');
  });

  it('keeps everything when every extension is available', () => {
    const { list, skipped } = restoreList(
      toc,
      new Set(['vector', 'pg_session_jwt']),
      new Set(['vector']),
    );
    expect(skipped).toEqual([]);
    expect(list).toBe(toc);
  });

  it('refuses when an extension the migrations need is unavailable', () => {
    expect(() => restoreList(toc, new Set(['pg_session_jwt']), new Set(['vector']))).toThrow(
      /vector is required/u,
    );
  });
});

describe('requiredExtensions', () => {
  it('reads the extensions the migrations create', () => {
    expect(
      requiredExtensions([
        'CREATE EXTENSION IF NOT EXISTS vector;',
        'create extension "uuid-ossp";\nSELECT 1;',
        'CREATE TABLE t (id int);',
      ]),
    ).toEqual(['uuid-ossp', 'vector']);
  });
});
