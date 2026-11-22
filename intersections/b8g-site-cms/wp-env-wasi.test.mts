import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  generateWpConfigPhp,
  parseWpEnvJson,
  WpEnvWasiManager,
  type WpEnvInstance,
} from './wp-env-wasi.mts';

describe('parseWpEnvJson', () => {
  it('applies safe defaults and merges .wp-env.json with .wp-env.override.json', () => {
    const baseJson = JSON.stringify({
      core: 'WordPress/WordPress#6.7',
      plugins: ['./plugins/seo-pack'],
      themes: ['./themes/sovereign'],
      mappings: {
        './mu-plugins': 'wp-content/mu-plugins',
      },
      config: {
        WP_DEBUG_LOG: true,
        CUSTOM_FLAG: 'base',
      },
    });

    const overrideJson = JSON.stringify({
      phpVersion: '8.4',
      multisite: true,
      port: 9999,
      plugins: ['./plugins/seo-pack', './plugins/dev-bar'],
      mappings: {
        './local-overrides': 'wp-content/plugins/local-overrides',
      },
      config: {
        CUSTOM_FLAG: 'override',
        SCRIPT_DEBUG: true,
        MAX_UPLOAD_MB: 64,
      },
    });

    const parsed = parseWpEnvJson(baseJson, overrideJson);

    assert.equal(parsed.phpVersion, '8.4');
    assert.equal(parsed.core, 'WordPress/WordPress#6.7');
    assert.equal(parsed.multisite, true);
    assert.equal(parsed.port, 9999);
    assert.deepEqual(parsed.plugins, ['./plugins/seo-pack', './plugins/dev-bar']);
    assert.deepEqual(parsed.themes, ['./themes/sovereign']);
    assert.deepEqual(parsed.mappings, {
      './mu-plugins': 'wp-content/mu-plugins',
      './local-overrides': 'wp-content/plugins/local-overrides',
    });
    assert.deepEqual(parsed.config, {
      WP_DEBUG: true,
      WP_DEBUG_LOG: true,
      CUSTOM_FLAG: 'override',
      SCRIPT_DEBUG: true,
      MAX_UPLOAD_MB: 64,
    });
  });

  it('falls back to safe defaults on empty object', () => {
    const parsed = parseWpEnvJson('{}');
    assert.equal(parsed.phpVersion, '8.3');
    assert.equal(parsed.core, null);
    assert.equal(parsed.multisite, false);
    assert.equal(parsed.port, 8888);
    assert.deepEqual(parsed.plugins, []);
    assert.deepEqual(parsed.themes, []);
    assert.deepEqual(parsed.mappings, {});
    assert.deepEqual(parsed.config, { WP_DEBUG: true });
  });
});

describe('generateWpConfigPhp', () => {
  it('emits SQLite WASI drop-in, custom constants, and multisite directives', () => {
    const env: WpEnvInstance = {
      id: 'env-test-1',
      tenantId: 'tenant-alpha',
      siteId: 'site-1',
      name: 'Alpha Multisite',
      runtime: 'php-wasi',
      status: 'running',
      dbEngine: 'sqlite-wasi',
      wasiMemoryMb: 512,
      envConfig: {
        phpVersion: '8.3',
        core: 'WordPress/WordPress#6.7',
        multisite: true,
        port: 8890,
        plugins: [],
        themes: [],
        mappings: {},
        config: {
          WP_DEBUG: true,
          WP_DEBUG_LOG: true,
          SCRIPT_DEBUG: false,
          SITE_TAG: "O'Brien's CMS",
          CACHE_TTL: 300,
        },
      },
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    };

    const php = generateWpConfigPhp(env);

    assert.match(php, /^<\?php/);
    assert.match(php, /define\(\s*'DB_ENGINE',\s*'sqlite'\s*\);/);
    assert.match(php, /define\(\s*'DB_FILE',\s*'wp\.sqlite'\s*\);/);
    assert.match(php, /define\(\s*'WP_DEBUG',\s*true\s*\);/);
    assert.match(php, /define\(\s*'WP_DEBUG_LOG',\s*true\s*\);/);
    assert.match(php, /define\(\s*'SCRIPT_DEBUG',\s*false\s*\);/);
    assert.match(php, /define\(\s*'SITE_TAG',\s*'O\\'Brien\\'s CMS'\s*\);/);
    assert.match(php, /define\(\s*'CACHE_TTL',\s*300\s*\);/);
    assert.match(php, /define\(\s*'WP_ALLOW_MULTISITE',\s*true\s*\);/);
    assert.match(php, /define\(\s*'MULTISITE',\s*true\s*\);/);
    assert.match(php, /define\(\s*'DOMAIN_CURRENT_SITE',\s*'localhost:8890'\s*\);/);
    assert.match(php, /require_once ABSPATH \. 'wp-settings\.php';/);
  });

  it('omits multisite directives when multisite is false', () => {
    const env: WpEnvInstance = {
      id: 'env-single',
      tenantId: 'tenant-beta',
      siteId: 'site-2',
      name: 'Single Site',
      runtime: 'php-wasi',
      status: 'stopped',
      dbEngine: 'sqlite-wasi',
      wasiMemoryMb: 256,
      envConfig: parseWpEnvJson('{}'),
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    };

    const php = generateWpConfigPhp(env);
    assert.doesNotMatch(php, /WP_ALLOW_MULTISITE/);
    assert.doesNotMatch(php, /define\(\s*'MULTISITE'/);
  });
});

describe('WpEnvWasiManager lifecycle', () => {
  it('seeds default env and persists full create -> mount -> start -> update -> reset -> stop -> reload lifecycle', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-wp-env-wasi-'));

    try {
      const manager = new WpEnvWasiManager(tmpDir);

      // Verify seeded awesome-os-wp-wasi environment
      const seeded = manager.getEnv('awesome-os-wp-wasi');
      assert.ok(seeded, 'default awesome-os-wp-wasi environment should be seeded');
      assert.equal(seeded.runtime, 'php-wasi');
      assert.equal(seeded.dbEngine, 'sqlite-wasi');
      assert.equal(seeded.envConfig.phpVersion, '8.3');
      assert.equal(seeded.envConfig.multisite, true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'wp-envs.json')), true);

      // createEnv
      const created = manager.createEnv({
        tenantId: 'tenant-acme',
        siteId: 'acme-blog',
        name: 'Acme WASI Staging',
        wasiMemoryMb: 512,
        envConfig: {
          phpVersion: '8.4',
          core: 'WordPress/WordPress#6.7',
          multisite: false,
          port: 9001,
          config: {
            WP_DEBUG: true,
            SCRIPT_DEBUG: true,
          },
        },
      });
      assert.equal(created.status, 'stopped');
      assert.equal(created.runtime, 'php-wasi');
      assert.equal(created.dbEngine, 'sqlite-wasi');
      assert.equal(created.wasiMemoryMb, 512);
      assert.equal(manager.listEnvs('tenant-acme').length, 1);

      // mountArtifact (plugin + theme)
      const withPlugin = manager.mountArtifact(created.id, 'plugin', './plugins/acme-blocks');
      assert.deepEqual(withPlugin.envConfig.plugins, ['./plugins/acme-blocks']);
      assert.equal(
        withPlugin.envConfig.mappings['./plugins/acme-blocks'],
        'wp-content/plugins/acme-blocks',
      );

      const withTheme = manager.mountArtifact(created.id, 'theme', './themes/acme-starter');
      assert.deepEqual(withTheme.envConfig.themes, ['./themes/acme-starter']);
      assert.equal(
        withTheme.envConfig.mappings['./themes/acme-starter'],
        'wp-content/themes/acme-starter',
      );

      // startEnv -> materializes wp-config.php and .wp-env.json on disk
      const started = manager.startEnv(created.id);
      assert.equal(started.status, 'running');
      assert.ok(started.lastStartedAt);

      const envDir = path.join(tmpDir, 'wp-envs', created.id);
      const wpConfigPath = path.join(envDir, 'wp-config.php');
      const wpEnvJsonPath = path.join(envDir, '.wp-env.json');
      assert.equal(fs.existsSync(wpConfigPath), true, 'wp-config.php must be materialized');
      assert.equal(fs.existsSync(wpEnvJsonPath), true, '.wp-env.json must be materialized');

      const materializedPhp = fs.readFileSync(wpConfigPath, 'utf8');
      assert.match(materializedPhp, /define\(\s*'SCRIPT_DEBUG',\s*true\s*\);/);

      const exported = manager.exportWpEnvJson(created.id);
      assert.equal(fs.readFileSync(wpEnvJsonPath, 'utf8'), exported);

      // updateEnvConfig while running refreshes disk files
      const updated = manager.updateEnvConfig(created.id, {
        multisite: true,
        config: {
          WP_DEBUG_LOG: true,
        },
      });
      assert.equal(updated.envConfig.multisite, true);
      assert.equal(updated.envConfig.config.WP_DEBUG_LOG, true);
      assert.equal(updated.envConfig.config.SCRIPT_DEBUG, true);

      const refreshedPhp = fs.readFileSync(wpConfigPath, 'utf8');
      assert.match(refreshedPhp, /define\(\s*'WP_ALLOW_MULTISITE',\s*true\s*\);/);
      assert.match(refreshedPhp, /define\(\s*'WP_DEBUG_LOG',\s*true\s*\);/);

      // resetDatabase
      const dbFilePath = path.join(envDir, 'db', 'wp.sqlite');
      fs.writeFileSync(dbFilePath, 'dummy-sqlite-bytes', 'utf8');
      const resetRes = manager.resetDatabase(created.id);
      assert.equal(resetRes.ok, true);
      assert.equal(resetRes.id, created.id);
      assert.ok(resetRes.resetAt);
      assert.equal(fs.readFileSync(dbFilePath, 'utf8'), '');

      // stopEnv
      const stopped = manager.stopEnv(created.id);
      assert.equal(stopped.status, 'stopped');

      // Disk reload persistence
      const reloaded = new WpEnvWasiManager(tmpDir);
      assert.equal(reloaded.listEnvs().length, 2);
      const persisted = reloaded.getEnv(created.id);
      assert.ok(persisted);
      assert.equal(persisted.status, 'stopped');
      assert.equal(persisted.lastStartedAt, started.lastStartedAt);
      assert.equal(persisted.envConfig.multisite, true);
      assert.deepEqual(persisted.envConfig.plugins, ['./plugins/acme-blocks']);
      assert.deepEqual(persisted.envConfig.themes, ['./themes/acme-starter']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
