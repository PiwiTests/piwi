import { describe, test, expect } from 'vitest';
import {
  ENV_OUTPUT_FORMATS,
  ENV_OUTPUT_GROUPS,
  emitCoolifyCompose,
  emitDockerCompose,
  emitDockerRunBash,
  emitDockerRunPowershell,
  emitDotenv,
  emitFlyToml,
  emitKoyebDeployUrl,
  emitKubernetes,
  emitPowershellEnv,
  emitRailwayTemplate,
  emitRenderBlueprint,
  emitShellExports,
  emitSystemd,
  quoteDotenvValue,
  quotePowershellValue,
  quoteShellValue,
  quoteTomlValue,
  quoteYamlValue,
  type EnvEntry,
} from '#shared/env-format';

const plain = (name: string, value: string): EnvEntry => ({ name, value });
const secret = (name: string, value: string): EnvEntry => ({ name, value, secret: true });
/** A secret the hosting platform is asked to generate, so nothing is committed. */
const generated = (name: string): EnvEntry => ({ name, value: '', secret: true, platformValue: 'generate' });

describe('quoteDotenvValue', () => {
  test('leaves simple values unquoted', () => {
    expect(quoteDotenvValue('local')).toBe('local');
    expect(quoteDotenvValue('.data/piwi.db')).toBe('.data/piwi.db');
    expect(quoteDotenvValue('https://piwi.example.com')).toBe('https://piwi.example.com');
    expect(quoteDotenvValue('587')).toBe('587');
    expect(quoteDotenvValue('a,b,c')).toBe('a,b,c');
  });

  test('double-quotes values with spaces, hashes and quotes', () => {
    expect(quoteDotenvValue('has space')).toBe('"has space"');
    expect(quoteDotenvValue('a#b')).toBe('"a#b"');
    expect(quoteDotenvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteDotenvValue('back\\slash')).toBe('"back\\\\slash"');
  });

  test('escapes newlines in double quotes', () => {
    expect(quoteDotenvValue('Wait for timeout*\n*waitForTimeout*')).toBe('"Wait for timeout*\\n*waitForTimeout*"');
  });

  test('single-quotes values containing $ so interpolation never rewrites them', () => {
    expect(quoteDotenvValue('pa$$word')).toBe("'pa$$word'");
  });

  test('keeps empty values empty', () => {
    expect(quoteDotenvValue('')).toBe('');
  });
});

describe('shell quoting', () => {
  test('bash single quotes with embedded quote escape', () => {
    expect(quoteShellValue('plain')).toBe("'plain'");
    expect(quoteShellValue("it's")).toBe("'it'\\''s'");
  });

  test('powershell doubles embedded single quotes', () => {
    expect(quotePowershellValue('plain')).toBe("'plain'");
    expect(quotePowershellValue("it's")).toBe("'it''s'");
  });
});

describe('quoteYamlValue', () => {
  test('always quotes so booleans and numbers stay strings', () => {
    expect(quoteYamlValue('true')).toBe("'true'");
    expect(quoteYamlValue('587')).toBe("'587'");
    expect(quoteYamlValue('0.92')).toBe("'0.92'");
  });

  test('doubles single quotes in single-quoted style', () => {
    expect(quoteYamlValue("it's")).toBe("'it''s'");
  });

  test('uses double-quoted style with escapes for control characters', () => {
    expect(quoteYamlValue('a\nb')).toBe('"a\\nb"');
    expect(quoteYamlValue('a\tb')).toBe('"a\\tb"');
  });
});

describe('emitDotenv', () => {
  test('renders entries with comments and header', () => {
    const out = emitDotenv(
      [
        { ...plain('PIWI_SITE_URL', 'https://piwi.example.com'), comment: 'Public base URL' },
        plain('PIWI_SMTP_PORT', '587'),
      ],
      { header: ['Generated locally'] },
    );
    expect(out).toBe(
      '# Generated locally\n\n# Public base URL\nPIWI_SITE_URL=https://piwi.example.com\nPIWI_SMTP_PORT=587\n',
    );
  });
});

describe('emitShellExports / emitPowershellEnv', () => {
  test('bash exports', () => {
    expect(emitShellExports([plain('PIWI_AUTH_ENABLED', 'true')])).toBe("export PIWI_AUTH_ENABLED='true'\n");
  });

  test('powershell env assignments', () => {
    expect(emitPowershellEnv([plain('PIWI_AUTH_ENABLED', 'true')])).toBe("$env:PIWI_AUTH_ENABLED = 'true'\n");
  });
});

describe('docker run emitters', () => {
  const entries = [plain('PIWI_AUTH_ENABLED', 'true'), secret('PIWI_AUTH_SECRET', "s3cr'et")];

  test('bash form uses backslash continuations and single quotes', () => {
    const out = emitDockerRunBash(entries);
    expect(out).toContain('docker run -d --name piwi \\');
    expect(out).toContain("  -e PIWI_AUTH_ENABLED='true' \\");
    expect(out).toContain("  -e PIWI_AUTH_SECRET='s3cr'\\''et' \\");
    expect(out.trimEnd().endsWith('phenx/piwitests-server:latest')).toBe(true);
  });

  test('powershell form uses backtick continuations and doubled quotes', () => {
    const out = emitDockerRunPowershell(entries);
    expect(out).toContain('docker run -d --name piwi `');
    expect(out).toContain("  -e PIWI_AUTH_SECRET='s3cr''et' `");
    expect(out).toContain('-v "${PWD}/.data:/app/.data" `');
  });

  test('honors a custom image', () => {
    expect(emitDockerRunBash(entries, { image: 'piwi-dashboard:local' })).toContain('piwi-dashboard:local');
  });
});

describe('emitDockerCompose', () => {
  test('quotes every value and keeps the canonical service shape', () => {
    const out = emitDockerCompose([plain('PIWI_SMTP_PORT', '587'), plain('PIWI_AUTH_ENABLED', 'true')]);
    expect(out).toContain('image: phenx/piwitests-server:latest');
    expect(out).toContain("      PIWI_SMTP_PORT: '587'");
    expect(out).toContain("      PIWI_AUTH_ENABLED: 'true'");
    expect(out).toContain('- ./.data:/app/.data');
  });

  test('renders an empty environment map when no entries', () => {
    expect(emitDockerCompose([])).toContain('environment:\n      {}');
  });
});

describe('emitKubernetes', () => {
  test('splits secrets into a Secret and references both', () => {
    const out = emitKubernetes([plain('PIWI_AUTH_ENABLED', 'true'), secret('PIWI_AUTH_SECRET', 'abc')]);
    const docs = out.split('\n---\n');
    expect(docs[0]).toContain('kind: ConfigMap');
    expect(docs[0]).toContain("  PIWI_AUTH_ENABLED: 'true'");
    expect(docs[0]).not.toContain('PIWI_AUTH_SECRET');
    expect(docs[1]).toContain('kind: Secret');
    expect(docs[1]).toContain('stringData:');
    expect(docs[1]).toContain("  PIWI_AUTH_SECRET: 'abc'");
    expect(out).toContain('secretRef:');
  });

  test('omits the Secret document when nothing is secret', () => {
    const out = emitKubernetes([plain('PIWI_SITE_URL', 'https://x.example')]);
    expect(out).not.toContain('kind: Secret');
    expect(out).not.toContain('secretRef:');
    expect(out).toContain('configMapRef:');
  });
});

describe('emitSystemd', () => {
  test('includes usage instructions and dotenv-style lines', () => {
    const out = emitSystemd([plain('PIWI_SITE_URL', 'https://piwi.example.com')]);
    expect(out).toContain('EnvironmentFile=/etc/piwi/piwi.env');
    expect(out).toContain('PIWI_SITE_URL=https://piwi.example.com');
  });
});

describe('quoteTomlValue', () => {
  test('always emits a basic string and escapes what TOML requires', () => {
    expect(quoteTomlValue('true')).toBe('"true"');
    expect(quoteTomlValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteTomlValue('back\\slash')).toBe('"back\\\\slash"');
    expect(quoteTomlValue('a\nb')).toBe('"a\\nb"');
  });
});

describe('emitRenderBlueprint', () => {
  test('pulls a qualified image onto a paid plan with a disk at the data mount', () => {
    const out = emitRenderBlueprint([plain('PIWI_AUTH_ENABLED', 'true')]);
    expect(out).toContain('runtime: image');
    expect(out).toContain('url: docker.io/phenx/piwitests-server:latest');
    expect(out).toContain('healthCheckPath: /api/health');
    expect(out).toContain('mountPath: /app/.data');
    expect(out).toContain('autoDeploy: false');
    // A free web service has no disk, which would drop the database on redeploy.
    expect(out).not.toContain('plan: free');
  });

  test('asks Render to generate secrets rather than carrying a literal', () => {
    const out = emitRenderBlueprint([generated('PIWI_AUTH_SECRET')]);
    expect(out).toContain('- key: PIWI_AUTH_SECRET\n        generateValue: true');
  });

  test('leaves a registry-qualified image alone', () => {
    expect(emitRenderBlueprint([], { image: 'ghcr.io/piwitests/platform:latest' })).toContain(
      'url: ghcr.io/piwitests/platform:latest',
    );
  });

  test('omits envVars entirely when there is nothing to set', () => {
    expect(emitRenderBlueprint([])).not.toContain('envVars:');
  });
});

describe('emitFlyToml', () => {
  const out = emitFlyToml([plain('PIWI_AUTH_ENABLED', 'true'), generated('PIWI_AUTH_SECRET')]);

  test('mounts a volume and health-checks the real endpoint', () => {
    expect(out).toContain('destination = "/app/.data"');
    expect(out).toContain('path = "/api/health"');
    expect(out).toContain('internal_port = 3000');
  });

  test('keeps one machine always on for the in-process cron', () => {
    expect(out).toContain('auto_stop_machines = false');
    expect(out).toContain('min_machines_running = 1');
  });

  test('routes secrets to fly secrets set instead of the committed [env] block', () => {
    expect(out).toContain('fly secrets set PIWI_AUTH_SECRET=$(openssl rand -hex 32)');
    expect(out.split('[mounts]')[0]).not.toContain('PIWI_AUTH_SECRET =');
  });

  test('leaves the public URL to the app name the server reads at start', () => {
    const named = emitFlyToml([{ name: 'PIWI_SITE_URL', value: '', platformValue: 'url' }], { name: 'piwi-tests' });
    expect(named).not.toContain('PIWI_SITE_URL =');
    expect(named).not.toContain('piwi-tests.fly.dev');
    expect(named).toContain('# PIWI_SITE_URL defaults to https://<app>.fly.dev');
    expect(named).toContain('source = "piwi_tests_data"');
  });
});

describe('emitRailwayTemplate', () => {
  test('documents the service and uses Railway variable functions for secrets', () => {
    const out = emitRailwayTemplate([
      generated('PIWI_AUTH_SECRET'),
      { name: 'PIWI_SITE_URL', value: '', platformValue: 'url' },
    ]);
    expect(out).toContain('| Volume mount path | `/app/.data` |');
    expect(out).toContain('| Health check path | `/api/health` |');
    expect(out).toContain('| `PIWI_AUTH_SECRET` | `${{ secret(64) }}` |');
    expect(out).toContain('| `PIWI_SITE_URL` | `https://${{ RAILWAY_PUBLIC_DOMAIN }}` |');
  });

  test('drops the variables table when there are none', () => {
    expect(emitRailwayTemplate([])).not.toContain('## Variables');
  });
});

describe('emitKoyebDeployUrl', () => {
  const out = emitKoyebDeployUrl([plain('PIWI_AUTH_ENABLED', 'true'), generated('PIWI_SECRET_KEY')]);

  test('carries the whole service definition in the query string', () => {
    expect(out).toContain('https://app.koyeb.com/deploy?type=docker');
    expect(out).toContain('image=docker.io/phenx/piwitests-server:latest');
    expect(out).toContain('ports=3000;http;/');
    expect(out).toContain('env[PIWI_AUTH_ENABLED]=true');
  });

  test('spells out the volume caveat and defers what the URL cannot carry', () => {
    expect(out).toContain('koyeb service update piwi/piwi --volumes piwi-data:/app/.data');
    expect(out).toContain('Set in the Koyeb console: PIWI_SECRET_KEY.');
    expect(out).not.toContain('env[PIWI_SECRET_KEY]');
  });

  test('percent-encodes values that would break the query string', () => {
    expect(emitKoyebDeployUrl([plain('PIWI_SITE_URL', 'https://a.example/b c')])).toContain(
      'env[PIWI_SITE_URL]=https%3A%2F%2Fa.example%2Fb%20c',
    );
  });
});

describe('emitCoolifyCompose', () => {
  const out = emitCoolifyCompose([
    generated('PIWI_AUTH_SECRET'),
    { name: 'PIWI_SITE_URL', value: '', platformValue: 'url' },
  ]);

  test('uses Coolify magic variables for the domain and the secrets', () => {
    expect(out).toContain('- SERVICE_URL_PIWI_3000\n');
    expect(out).toContain('- PIWI_AUTH_SECRET=${SERVICE_PASSWORD_64_PIWIAUTHSECRET}');
    // The URL variable, unlike SERVICE_FQDN_*, carries the scheme the site URL needs.
    expect(out).toContain('- PIWI_SITE_URL=${SERVICE_URL_PIWI_3000}');
    expect(out).not.toContain('SERVICE_FQDN_');
  });

  test("keys the URL variable by the service's name", () => {
    expect(emitCoolifyCompose([], { name: 'piwi-tests' })).toContain('- SERVICE_URL_PIWI_TESTS_3000\n');
  });

  test('declares a named volume at the data mount and a health check', () => {
    expect(out).toContain('- piwi-data:/app/.data');
    expect(out).toContain("'http://127.0.0.1:3000/api/health'");
    expect(out).toMatch(/^volumes:\n {2}piwi-data:$/m);
  });
});

describe('hosting-platform formats', () => {
  const hosting = ENV_OUTPUT_FORMATS.filter((format) => format.group === 'Hosting platforms');

  test('cover every provider the docs advertise', () => {
    expect(hosting.map((format) => format.id)).toEqual(['railway', 'render', 'fly', 'koyeb', 'coolify']);
  });

  test('each one mounts the data volume and checks the health endpoint', () => {
    for (const format of hosting) {
      const out = format.emit([]);
      // Koyeb attaches its volume out of band, so it documents the command instead.
      expect(out, format.id).toContain('/app/.data');
      expect(out, format.id).toContain('/api/health');
    }
  });

  test('never inline a value the platform is meant to generate', () => {
    for (const format of hosting) {
      const out = format.emit([
        { name: 'PIWI_AUTH_SECRET', value: 'leaked-literal', secret: true, platformValue: 'generate' },
      ]);
      expect(out, format.id).not.toContain('leaked-literal');
    }
  });
});

describe('ENV_OUTPUT_FORMATS', () => {
  test('ids are unique and every format emits the variable name', () => {
    const ids = ENV_OUTPUT_FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const format of ENV_OUTPUT_FORMATS) {
      const out = format.emit([plain('PIWI_SITE_URL', 'https://piwi.example.com')]);
      expect(out, format.id).toContain('PIWI_SITE_URL');
      expect(format.filename.length).toBeGreaterThan(0);
      expect(format.label.length).toBeGreaterThan(0);
    }
  });

  test('every format belongs to a declared group, and every group is used', () => {
    const groups = new Set(ENV_OUTPUT_FORMATS.map((format) => format.group));
    for (const group of groups) expect(ENV_OUTPUT_GROUPS).toContain(group);
    for (const group of ENV_OUTPUT_GROUPS) expect(groups.has(group)).toBe(true);
  });
});
