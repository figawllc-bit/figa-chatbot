// Bundles every migration in supabase/migrations/ (filename order) into ONE file to paste
// into the SEPARATE production Supabase project's SQL Editor. Reads no secrets; writes
// .wrangler/production-setup.sql (git-ignored). Then run supabase/production/configure.sql.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = new URL('../supabase/migrations/', import.meta.url);
const files = readdirSync(folder).filter(f => f.endsWith('.sql')).sort();
const parts = [
  '-- FIGA production database setup: all migrations in order (' + files.length + ' files).',
  '-- Run ONCE in the SEPARATE production project (never the development project), on an empty database.',
  '-- Afterwards run supabase/production/configure.sql, then supabase/production/add_staff.sql per staff member.',
  ...files.map(f => `\n-- ===== ${f} =====\n` + readFileSync(new URL(f, folder), 'utf8')),
];
const out = new URL('../.wrangler/production-setup.sql', import.meta.url);
mkdirSync(new URL('../.wrangler/', import.meta.url), { recursive: true });
writeFileSync(out, parts.join('\n'));
console.log(`Wrote ${fileURLToPath(out)} (${files.length} migrations). Paste it into the production project's SQL Editor.`);
