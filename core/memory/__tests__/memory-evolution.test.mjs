import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_TOP_NEIGHBORS,
  applyEvolution,
  evolveAgainst,
  findNeighbors,
  proposeEvolution
} from '../memory-evolution.mjs';

test('findNeighbors returns lessons above threshold and excludes self', () => {
  const newLesson = { id: 'L_new', tokens: ['hook', 'capture', 'event'] };
  const all = [
    { id: 'L1', tokens: ['hook', 'capture', 'event'] },           // similarity 1.0
    { id: 'L2', tokens: ['hook', 'capture', 'foo'] },             // 0.5 -> filtered
    { id: 'L_new', tokens: ['hook', 'capture', 'event'] },        // self
    { id: 'L3', tokens: ['hook', 'capture', 'event', 'extra'] }   // 0.75
  ];
  const neighbors = findNeighbors(newLesson, all, 0.7);
  const ids = neighbors.map((n) => n.lesson.id);
  assert.deepEqual(ids, ['L1', 'L3']);
});

test('findNeighbors caps at top-N sorted by similarity', () => {
  const newLesson = { id: 'L_new', tokens: ['a', 'b', 'c', 'd'] };
  const all = Array.from({ length: 5 }, (_, idx) => ({
    id: `L${idx}`,
    tokens: ['a', 'b', 'c', 'd']
  }));
  const neighbors = findNeighbors(newLesson, all, 0.7, 3);
  assert.equal(neighbors.length, 3);
});

test('proposeEvolution skips when from_lesson already recorded', () => {
  const newLesson = { id: 'L_new' };
  const neighbor = { id: 'L1', evolved_at: [{ at: '2026-01-01T00:00:00Z', from_lesson: 'L_new' }] };
  const proposal = proposeEvolution(newLesson, neighbor);
  assert.equal(proposal, null);
});

test('proposeEvolution + applyEvolution appends evolved_at entry in-place', () => {
  const newLesson = { id: 'L_new' };
  const neighbor = { id: 'L1', evolved_at: [], updated_at: '2026-01-01T00:00:00Z' };
  const nowIso = '2026-04-23T00:00:00Z';
  const proposal = proposeEvolution(newLesson, neighbor, nowIso);
  assert.ok(proposal);
  assert.equal(proposal.changes.evolved_at_append.from_lesson, 'L_new');
  assert.equal(proposal.changes.evolved_at_append.at, nowIso);

  const result = applyEvolution(neighbor, proposal);
  assert.strictEqual(result, neighbor); // in-place mutation
  assert.equal(neighbor.evolved_at.length, 1);
  assert.equal(neighbor.evolved_at[0].from_lesson, 'L_new');
  assert.equal(neighbor.updated_at, nowIso);
});

test('evolveAgainst integrates findNeighbors + propose + apply', () => {
  const newLesson = { id: 'L_new', tokens: ['a', 'b', 'c'] };
  const all = [
    { id: 'L1', tokens: ['a', 'b', 'c'], evolved_at: [] },
    { id: 'L2', tokens: ['x', 'y'], evolved_at: [] }, // below threshold
    { id: 'L3', tokens: ['a', 'b', 'c', 'd'], evolved_at: [] } // 0.75
  ];
  const updated = evolveAgainst(newLesson, all, { nowIso: '2026-04-23T00:00:00Z' });
  const updatedIds = updated.map((entry) => entry.lessonId).sort();
  assert.deepEqual(updatedIds, ['L1', 'L3']);
  assert.equal(all[0].evolved_at.length, 1);
  assert.equal(all[1].evolved_at.length, 0); // untouched
});

test('exposed defaults match spec', () => {
  assert.equal(DEFAULT_SIMILARITY_THRESHOLD, 0.7);
  assert.equal(DEFAULT_TOP_NEIGHBORS, 3);
});
