// Tests for the pure helpers in app.js. Run with: node test.js
'use strict';
const assert = require('assert');
const app = require('./app.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('✓ ' + name);
}
const r2 = (n) => (n === null ? null : app.roundMoney(n));

test('12.99 for 0.75 l at 13% ABV', () => {
  const { perLiter, perAlcoholLiter } = app.calcPrices(12.99, 0.75, 'l', 13);
  assert.strictEqual(r2(perLiter), 17.32);         // 12.99 / 0.75
  assert.strictEqual(r2(perAlcoholLiter), 133.23); // 12.99 / (0.75 * 0.13)
});

test('same bottle entered as 750 ml gives the same result', () => {
  const ml = app.calcPrices(12.99, 750, 'ml', 13);
  const l = app.calcPrices(12.99, 0.75, 'l', 13);
  assert.strictEqual(r2(ml.perLiter), r2(l.perLiter));
  assert.strictEqual(r2(ml.perAlcoholLiter), r2(l.perAlcoholLiter));
});

test('beer: 1.29 for 500 ml at 4.9%', () => {
  const r = app.calcPrices(1.29, 500, 'ml', 4.9);
  assert.strictEqual(r2(r.perLiter), 2.58);
  assert.strictEqual(r2(r.perAlcoholLiter), 52.65);
});

test('spirits: 24.90 for 0.7 l at 40%', () => {
  const r = app.calcPrices(24.9, 0.7, 'l', 40);
  assert.strictEqual(r2(r.perLiter), 35.57);
  assert.strictEqual(r2(r.perAlcoholLiter), 88.93);
});

test('empty / zero values give null, never NaN or Infinity', () => {
  const cases = [
    [null, 0.75, 'l', 13], [12.99, null, 'l', 13], [12.99, 0, 'l', 13],
    [12.99, 0.75, 'l', null], [12.99, 0.75, 'l', 0], [NaN, 0.75, 'l', 13], [12.99, NaN, 'ml', NaN],
  ];
  for (const c of cases) {
    const r = app.calcPrices(...c);
    for (const v of [r.perLiter, r.perAlcoholLiter]) {
      assert.ok(v === null || Number.isFinite(v), `got ${v} for ${JSON.stringify(c)}`);
    }
  }
  assert.strictEqual(app.calcPrices(12.99, 0.75, 'l', 0).perAlcoholLiter, null); // alcohol-free: no per-alcohol price
  assert.strictEqual(r2(app.calcPrices(12.99, 0.75, 'l', 0).perLiter), 17.32);
  assert.strictEqual(app.calcPrices(0, 1, 'l', 5).perLiter, 0); // free drink is fine
});

test('parseNumber accepts comma and dot, rejects junk', () => {
  assert.strictEqual(app.parseNumber('12,99'), 12.99);
  assert.strictEqual(app.parseNumber(' 12.99 '), 12.99);
  assert.strictEqual(app.parseNumber(''), null);
  assert.ok(Number.isNaN(app.parseNumber('12.9.9')));
  assert.ok(Number.isNaN(app.parseNumber('abc')));
  assert.strictEqual(app.parseNumber('-3'), -3);
});

test('roundMoney rounds to cents correctly', () => {
  assert.strictEqual(app.roundMoney(1.005), 1.01);
  assert.strictEqual(app.roundMoney(0.1 + 0.2), 0.3);
});

test('validation: negatives, ABV range, rating', () => {
  const base = { name: 'Riesling', tabId: 't1', rating: '8', price: '12,99', volume: '0.75', volumeUnit: 'l', abv: '13' };
  assert.deepStrictEqual(app.validateDrink(base).errors, {});
  assert.strictEqual(app.validateDrink(base).values.price, 12.99);
  assert.ok(app.validateDrink({ ...base, price: '-1' }).errors.price);
  assert.ok(app.validateDrink({ ...base, volume: '0' }).errors.volume);
  assert.ok(app.validateDrink({ ...base, abv: '101' }).errors.abv);
  assert.ok(app.validateDrink({ ...base, abv: '-0.5' }).errors.abv);
  assert.ok(app.validateDrink({ ...base, rating: '0' }).errors.rating);
  assert.ok(app.validateDrink({ ...base, name: '  ' }).errors.name);
  assert.deepStrictEqual(app.validateDrink({ ...base, price: '', volume: '', abv: '' }).errors, {}); // optional fields
});

test('filter, sort and best value', () => {
  const drinks = [
    { id: 'a', name: 'Wine', tabId: 'w', rating: 8, price: 12.99, volume: 0.75, volumeUnit: 'l', abv: 13, createdAt: 1 },
    { id: 'b', name: 'Beer', tabId: 'b', rating: 6, price: 1.29, volume: 500, volumeUnit: 'ml', abv: 4.9, createdAt: 2 },
    { id: 'c', name: 'Mystery', tabId: 'w', rating: 9, price: null, volume: null, volumeUnit: 'ml', abv: null, createdAt: 3 },
  ];
  const view = (o) => app.applyView(drinks, { tabId: 'all', search: '', minRating: 0, maxPerLiter: null, sort: 'date', ...o });
  assert.deepStrictEqual(view({}).map((d) => d.id), ['c', 'b', 'a']);
  assert.deepStrictEqual(view({ sort: 'perLiter' }).map((d) => d.id), ['b', 'a', 'c']); // missing last
  assert.deepStrictEqual(view({ sort: 'rating' }).map((d) => d.id), ['c', 'a', 'b']);
  assert.deepStrictEqual(view({ tabId: 'w' }).map((d) => d.id), ['c', 'a']);
  assert.deepStrictEqual(view({ minRating: 7, search: 'WIN' }).map((d) => d.id), ['a']);
  assert.deepStrictEqual(view({ maxPerLiter: 10 }).map((d) => d.id), ['b']);
  assert.strictEqual(app.pickBestValue(view({})), 'b');           // 6 / 2.58 beats 8 / 17.32
  assert.strictEqual(app.pickBestValue(view({ tabId: 'w' })), 'a');
});

test('backup parsing keeps drinks whose tab is missing', () => {
  const out = app.parseBackup({
    tabs: [{ id: 't1', name: 'Wine', order: 0 }, { id: 't2', name: 'Other', order: 1 }],
    drinks: [{ id: 'x', name: 'Lost', tabId: 'gone', rating: 5, price: 3, volume: 1, volumeUnit: 'l', abv: 5 }],
  });
  assert.strictEqual(out.drinks[0].tabId, 't2');
  assert.throws(() => app.parseBackup({ foo: 1 }));
  assert.throws(() => app.parseBackup({ tabs: [], drinks: [{ name: 'x', rating: 50 }] }));
});

test('free label reading: ABV and volume only when unambiguous', () => {
  const L = app.parseLabelText;
  assert.deepStrictEqual(L('RIESLING TROCKEN\n2021\nalc. 12,5% vol  0,75 l ℮'), { abv: 12.5, volumeMl: 750, conflicting: false });
  assert.deepStrictEqual(L('SINGLE MALT 40% Vol. 70cl'), { abv: 40, volumeMl: 700, conflicting: false });
  assert.deepStrictEqual(L('Pils 4,9 % vol 500 ml'), { abv: 4.9, volumeMl: 500, conflicting: false });
  assert.deepStrictEqual(L('ABV 5.2% 330ml can'), { abv: 5.2, volumeMl: 330, conflicting: false });
  assert.deepStrictEqual(L('Alkoholgehalt: 13 %  1,5 L'), { abv: 13, volumeMl: 1500, conflicting: false });
  // percentages not about alcohol are ignored, words starting with l are not liters
  assert.deepStrictEqual(L('100% Malt, 70% Merlot, 12 lager beers'), { abv: null, volumeMl: null, conflicting: false });
  // two different values -> unsure -> empty
  assert.deepStrictEqual(L('13% vol ... 14,5% vol'), { abv: null, volumeMl: null, conflicting: true });
  assert.deepStrictEqual(L(''), { abv: null, volumeMl: null, conflicting: false });
  assert.deepStrictEqual(L(null), { abv: null, volumeMl: null, conflicting: false });
});

(async () => {
  // Same hashes as `git hash-object`
  assert.strictEqual(await app.gitBlobSha(new Uint8Array(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.strictEqual(await app.gitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  passed++;
  console.log('✓ git blob hash matches git');

  assert.strictEqual(app.bytesToBase64(new TextEncoder().encode('Grüner Veltliner')), Buffer.from('Grüner Veltliner').toString('base64'));
  const remote = app.drinkToRemote({ id: 'x', name: 'A', photo: {}, thumb: {}, rating: 5 });
  assert.strictEqual(remote.hasPhoto, true);
  assert.ok(!('photo' in remote) && !('thumb' in remote));
  passed++;
  console.log('✓ GitHub file format (no blobs, UTF-8 safe)');

  console.log(`\nAll ${passed} tests passed.`);
})();

test('AI answer: JSON is extracted from fences or surrounding text', () => {
  assert.deepStrictEqual(app.extractJson('Here:\n```json\n{"name":"X"}\n```'), { name: 'X' });
  assert.deepStrictEqual(app.extractJson('I found it. {"name": "Y", "abv": 5} Done.'), { name: 'Y', abv: 5 });
  assert.strictEqual(app.extractJson('no json here'), null);
  assert.strictEqual(app.extractJson('{"broken": '), null);
  assert.strictEqual(app.extractJson(undefined), null);
});

test('AI answer: doubtful values become null, never invented', () => {
  const cats = ['Wine', 'Beer', 'Spirits'];
  const r = app.sanitizeAiResult({
    name: '  Riesling Trocken ', brand: 'unknown', category: 'wine', abv: '12,5 %', volume_ml: 750,
    country: 'Germany', region: null, description: 'N/A', from_web: ['abv', 3],
  }, cats);
  assert.strictEqual(r.name, 'Riesling Trocken');
  assert.strictEqual(r.brand, null);
  assert.strictEqual(r.category, 'Wine');          // matched to the user's category name
  assert.strictEqual(r.abv, 12.5);
  assert.strictEqual(r.volumeMl, 750);
  assert.strictEqual(r.region, null);
  assert.strictEqual(r.description, null);
  assert.deepStrictEqual(r.fromWeb, ['abv']);
  const bad = app.sanitizeAiResult({ abv: 140, volume_ml: -1, category: 'Cider', name: 42 }, cats);
  assert.strictEqual(bad.abv, null);
  assert.strictEqual(bad.volumeMl, null);
  assert.strictEqual(bad.category, null);           // not one of the user's categories
  assert.strictEqual(bad.name, null);
  assert.deepStrictEqual(app.sanitizeAiResult(null, cats).name, null);
  assert.ok(/^claude-/.test(app.AI_MODEL));
});

test('countries: English + German names, map grouping and counter', () => {
  assert.strictEqual(app.findCountry('deutschland').name, 'Germany');
  assert.strictEqual(app.findCountry(' Schottland ').name, 'Scotland');
  assert.strictEqual(app.findCountry('USA').name, 'United States');
  assert.strictEqual(app.findCountry('Atlantis'), null);
  const drinks = [
    { id: 1, country: 'Germany', region: null, lat: null, lng: null, geoQuery: null },
    { id: 2, country: 'Deutschland', region: null, lat: null, lng: null, geoQuery: null },
    { id: 3, country: 'France', region: 'Bordeaux', lat: 44.84, lng: -0.58, geoQuery: 'Bordeaux, France' },
    { id: 4, country: 'France', region: 'Alsace', lat: null, lng: null, geoQuery: null }, // not geocoded: falls back to France
    { id: 5, country: null, region: null },
    { id: 6, country: 'France', region: 'Champagne', lat: 49, lng: 4, geoQuery: 'Reims, France' }, // stale cache: ignored
  ];
  const { groups, without } = app.groupForMap(drinks);
  const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.drinks.map((d) => d.id)]));
  assert.deepStrictEqual(byLabel, { Germany: [1, 2], 'Bordeaux, France': [3], France: [4, 6] });
  assert.strictEqual(without, 1);
  assert.strictEqual(app.countCountries(drinks), 2);
  assert.strictEqual(app.geoQueryFor({ country: 'Germany', region: null }), null);   // table is enough
  assert.strictEqual(app.geoQueryFor({ country: 'Atlantis', region: null }), 'Atlantis');
  assert.strictEqual(app.geoQueryFor({ country: 'Italy', region: 'Piemonte' }), 'Piemonte, Italy');
});

test('old backups (without origin fields) still import; new fields round-trip', () => {
  const old = app.parseBackup({ tabs: [{ id: 't', name: 'Wine' }], drinks: [{ id: 'a', name: 'Old', tabId: 't', rating: 7 }] });
  assert.strictEqual(old.drinks[0].country, null);
  assert.strictEqual(old.drinks[0].lat, null);
  const neu = app.parseBackup({ tabs: [{ id: 't', name: 'Wine' }], drinks: [{
    id: 'b', name: 'New', tabId: 't', rating: 7, country: ' Italy ', region: 'Piemonte', lat: 44.7, lng: 8, geoQuery: 'Piemonte, Italy' }] });
  assert.strictEqual(neu.drinks[0].country, 'Italy');
  assert.strictEqual(neu.drinks[0].lat, 44.7);
  assert.strictEqual(neu.drinks[0].geoQuery, 'Piemonte, Italy');
  const junk = app.parseBackup({ tabs: [{ id: 't', name: 'Wine' }], drinks: [{ id: 'c', name: 'J', tabId: 't', rating: 7, lat: 'x', lng: 999 }] });
  assert.strictEqual(junk.drinks[0].lat, null);
  const remote = app.drinkToRemote(neu.drinks[0]);
  assert.strictEqual(remote.region, 'Piemonte');
  assert.strictEqual(remote.lng, 8);
});

