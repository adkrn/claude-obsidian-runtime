// DESIGN_MANUS_D §5-A — stableStringify deterministic JSON serialization.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify } from '../cache-stable-stringify.mjs';

describe('stableStringify — recursive sorted-key JSON', () => {
  it('sorts top-level keys', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ a: 2, m: 3, z: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"m":3,"z":1}');
  });

  it('sorts nested keys recursively', () => {
    const out = stableStringify({ outer: { z: 1, a: 2 }, alpha: { y: 1, b: 2 } });
    assert.equal(out, '{"alpha":{"b":2,"y":1},"outer":{"a":2,"z":1}}');
  });

  it('preserves array input order', () => {
    const out = stableStringify([3, 1, 2]);
    assert.equal(out, '[3,1,2]');
  });

  it('handles primitives like JSON.stringify', () => {
    assert.equal(stableStringify(0), '0');
    assert.equal(stableStringify('foo'), '"foo"');
    assert.equal(stableStringify(true), 'true');
    assert.equal(stableStringify(null), 'null');
  });

  it('omits undefined object values (JSON standard)', () => {
    const out = stableStringify({ a: 1, b: undefined, c: 3 });
    assert.equal(out, '{"a":1,"c":3}');
  });

  it('throws on circular references', () => {
    const obj = { a: 1 };
    obj.self = obj;
    assert.throws(() => stableStringify(obj), /circular/i);
  });

  it('respects options.space for pretty output', () => {
    const out = stableStringify({ b: 2, a: 1 }, { space: 2 });
    assert.equal(out, '{\n  "a": 1,\n  "b": 2\n}');
  });

  it('produces byte-stable output for deeply equal inputs built differently', () => {
    const o1 = {};
    o1.a = 1;
    o1.b = 2;
    o1.c = { y: 1, x: 2 };

    const o2 = {};
    o2.c = { x: 2, y: 1 };
    o2.b = 2;
    o2.a = 1;

    assert.equal(stableStringify(o1), stableStringify(o2));
  });
});
