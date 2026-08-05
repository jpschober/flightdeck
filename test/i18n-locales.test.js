'use strict';
// English is the source language and the fallback, so every other language has
// to carry the same set of keys - a missing one silently falls back to English,
// an extra one is a key nobody looks up any more.

const test = require('node:test');
const assert = require('node:assert');

const en = require('../src/i18n/locales/en');
const OTHERS = ['de', 'fr', 'it', 'es'];

for (const code of OTHERS) {
  test(`${code} carries exactly the keys en carries`, () => {
    const strings = require(`../src/i18n/locales/${code}`);
    const keys = new Set(Object.keys(strings));
    const enKeys = Object.keys(en);
    assert.deepStrictEqual(enKeys.filter((k) => !keys.has(k)), [], 'missing keys');
    assert.deepStrictEqual([...keys].filter((k) => !enKeys.includes(k)), [], 'unknown keys');
  });

  test(`${code} keeps the placeholders of every string`, () => {
    const strings = require(`../src/i18n/locales/${code}`);
    for (const [key, value] of Object.entries(strings)) {
      if (typeof value !== 'string' || typeof en[key] !== 'string') continue;
      const of = (s) => (s.match(/\{\w+\}/g) || []).sort();
      assert.deepStrictEqual(of(value), of(en[key]), `placeholders differ in ${key}`);
    }
  });
}
