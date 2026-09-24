import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

const root = path.join(__dirname, '..', '..');
const read = (file: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const placeholders = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();

for (const [source, translation] of [
	['l10n/bundle.l10n.json', 'l10n/bundle.l10n.pt-br.json'],
	['package.nls.json', 'package.nls.pt-br.json'],
]) {
	describe(`pt-BR translation of ${source}`, () => {
		const en = read(source);
		const pt = read(translation);

		it('translates every string and nothing extra', () => {
			assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
		});

		it('keeps the same placeholders, so no argument is lost or invented', () => {
			for (const [key, english] of Object.entries(en)) {
				assert.deepEqual(placeholders(pt[key]), placeholders(english), key);
			}
		});

		it('keeps leading and trailing whitespace, which callers concatenate', () => {
			for (const [key, english] of Object.entries(en)) {
				assert.equal(/^\s/.test(pt[key]), /^\s/.test(english), key);
				assert.equal(/\s$/.test(pt[key]), /\s$/.test(english), key);
			}
		});

		it('leaves no string untranslated by accident', () => {
			// Same text is fine for names and short technical words (CPU, VHDX, WSL {0}, root (uid 0)).
			const same = Object.keys(en).filter((k) => pt[k] === en[k] && k.split(' ').length > 3);
			assert.deepEqual(same, []);
		});
	});
}
