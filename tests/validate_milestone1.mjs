import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const rootDir = path.resolve(import.meta.dirname, '..');

console.log('Running Full Repository Validation (Milestones 1–10) in:', rootDir);

// 1. Validate all required files across Milestones 1-10
const requiredFiles = [
  'repository.yaml',
  'hacs.json',
  'logo.png',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  '.gitignore',
  // Add-on files
  'whatsapp_addon/config.yaml',
  'whatsapp_addon/logo.png',
  'whatsapp_addon/icon.png',
  'whatsapp_addon/Dockerfile',
  'whatsapp_addon/build.yaml',
  'whatsapp_addon/run.sh',
  'whatsapp_addon/package.json',
  'whatsapp_addon/package-lock.json',
  'whatsapp_addon/.dockerignore',
  'whatsapp_addon/README.md',
  'whatsapp_addon/DOCS.md',
  'whatsapp_addon/translations/en.yaml',
  'whatsapp_addon/rootfs/etc/services.d/whatsapp/run',
  'whatsapp_addon/rootfs/etc/services.d/whatsapp/finish',
  'whatsapp_addon/src/index.js',
  'whatsapp_addon/src/server.js',
  'whatsapp_addon/src/whatsapp/connection.js',
  'whatsapp_addon/src/whatsapp/session-manager.js',
  'whatsapp_addon/src/whatsapp/message-manager.js',
  'whatsapp_addon/src/whatsapp/media-manager.js',
  'whatsapp_addon/src/whatsapp/contact-manager.js',
  'whatsapp_addon/src/whatsapp/event-manager.js',
  'whatsapp_addon/src/api/routes.js',
  'whatsapp_addon/src/api/auth.js',
  'whatsapp_addon/src/api/middleware.js',
  'whatsapp_addon/src/services/queue.js',
  'whatsapp_addon/src/services/retry.js',
  'whatsapp_addon/src/services/storage.js',
  'whatsapp_addon/src/diagnostics/health.js',
  'whatsapp_addon/src/utils/logger.js',
  'whatsapp_addon/src/utils/validation.js',
  'whatsapp_addon/frontend/index.html',
  'whatsapp_addon/frontend/logo.png',
  'whatsapp_addon/frontend/css/styles.css',
  'whatsapp_addon/frontend/js/app.js',
  'whatsapp_addon/tests/addon.test.js',
  // HACS integration files
  'custom_components/whatsapp/__init__.py',
  'custom_components/whatsapp/manifest.json',
  'custom_components/whatsapp/logo.png',
  'custom_components/whatsapp/icon.png',
  'custom_components/whatsapp/brand/logo.png',
  'custom_components/whatsapp/brand/icon.png',
  'custom_components/whatsapp/config_flow.py',
  'custom_components/whatsapp/const.py',
  'custom_components/whatsapp/coordinator.py',
  'custom_components/whatsapp/api.py',
  'custom_components/whatsapp/services.py',
  'custom_components/whatsapp/sensor.py',
  'custom_components/whatsapp/binary_sensor.py',
  'custom_components/whatsapp/diagnostics.py',
  'custom_components/whatsapp/services.yaml',
  'custom_components/whatsapp/strings.json',
  'custom_components/whatsapp/translations/en.json',
  'custom_components/whatsapp/README.md',
  // Documentation files
  'docs/ARCHITECTURE.md',
  'docs/FEATURE_STATUS.md',
  'docs/INSTALLATION.md',
  'docs/CONFIGURATION.md',
  'docs/AUTOMATIONS.md',
  'docs/SERVICES.md',
  'docs/TROUBLESHOOTING.md',
  'docs/SECURITY.md',
  // GitHub Actions workflows
  '.github/workflows/build-addon.yml',
  '.github/workflows/validate-integration.yml',
  '.github/workflows/release.yml',
];

for (const relPath of requiredFiles) {
  const fullPath = path.join(rootDir, relPath);
  assert.ok(fs.existsSync(fullPath), `Missing required file: ${relPath}`);
  const stat = fs.statSync(fullPath);
  assert.ok(stat.size > 0, `File is empty: ${relPath}`);
}
console.log(`✔ All ${requiredFiles.length} required files across Milestones 1–10 exist and are non-empty.`);

// 2. Validate version consistency across config.yaml, package.json, and manifest.json
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'whatsapp_addon/package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'custom_components/whatsapp/manifest.json'), 'utf8'));
const configYaml = fs.readFileSync(path.join(rootDir, 'whatsapp_addon/config.yaml'), 'utf8');
const hacs = JSON.parse(fs.readFileSync(path.join(rootDir, 'hacs.json'), 'utf8'));
assert.equal(hacs.name, 'Lumi Whatsapp', 'hacs.json name must be Lumi Whatsapp');
assert.equal(manifest.name, 'Lumi Whatsapp', 'manifest.json name must be Lumi Whatsapp');
assert.match(configYaml, /^name:\s*["']?Lumi Whatsapp["']?/m, 'whatsapp_addon/config.yaml name must be Lumi Whatsapp');
const verMatch = configYaml.match(/^version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/m);
assert.ok(verMatch, 'whatsapp_addon/config.yaml missing semantic version');
assert.equal(pkg.version, verMatch[1], 'package.json version mismatch');
assert.equal(manifest.version, verMatch[1], 'manifest.json version mismatch');
console.log(`✔ Version consistency verified across Add-on and HACS Integration: v${verMatch[1]}`);

// 3. Validate all 12 services are documented in custom_components/whatsapp/services.yaml
const servicesYaml = fs.readFileSync(path.join(rootDir, 'custom_components/whatsapp/services.yaml'), 'utf8');
const requiredServices = [
  'send_message',
  'send_image',
  'send_video',
  'send_document',
  'send_audio',
  'send_location',
  'get_contacts',
  'get_groups',
  'check_number',
  'disconnect',
  'reconnect',
  'send_message_to_group',
];
for (const svc of requiredServices) {
  assert.match(servicesYaml, new RegExp(`^${svc}:`, 'm'), `services.yaml missing service definition: ${svc}`);
}
console.log('✔ All 12 native Home Assistant services are defined in custom_components/whatsapp/services.yaml.');

console.log('\nALL MILESTONE 1–10 STRUCTURAL & SCHEMA VALIDATION CHECKS PASSED.');
