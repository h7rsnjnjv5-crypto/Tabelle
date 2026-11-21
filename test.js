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

console.log(`\nAll ${passed} tests passed.`);
