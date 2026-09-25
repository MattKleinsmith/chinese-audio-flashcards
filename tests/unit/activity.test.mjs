// Unit tests for summariseReviews (site/js/screens/activity.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseReviews } from '../../site/js/screens/activity.js';

const H = 3600e3; const D = 24 * H;
const now = new Date('2026-09-25T15:00:00').getTime();

test('empty log', () => {
  const s = summariseReviews([], { now });
  assert.equal(s.total, 0); assert.equal(s.first, null); assert.equal(s.last, null);
  assert.equal(s.days.length, 14); assert.equal(s.today.reviews, 0); assert.deepEqual(s.recent, []);
});

test('counts per day with 4am boundary, ignores non-grade entries', () => {
  const reviews = [
    { cardId: 'word:a', ts: now - 1 * H, grade: 'good' },
    { cardId: 'word:a', ts: now - 2 * H, grade: 'again' },
    { cardId: 'sentence:b', ts: now - 3 * H, grade: 'easy' },
    { cardId: 'word:c', ts: now - 12 * H, grade: 'good' },      // 03:00 → belongs to yesterday (day starts 04:00)
    { cardId: 'word:d', ts: now - 30 * D, grade: 'good' },      // outside the window
    { cardId: 'word:e', ts: now - 1 * H, grade: 'bad-audio' },  // not a grade
  ];
  const s = summariseReviews(reviews, { now, dayStart: 4 });
  assert.equal(s.total, 5);
  assert.deepEqual({ r: s.today.reviews, c: s.today.cards, a: s.today.again }, { r: 3, c: 2, a: 1 });
  assert.equal(s.days[1].reviews, 1);
  assert.equal(s.first, now - 30 * D); assert.equal(s.last, now - 1 * H);
  assert.equal(s.recent[0].cardId, 'word:a'); assert.equal(s.recent.length, 5);
});

test('recent is capped at 40, newest first', () => {
  const reviews = Array.from({ length: 60 }, (_, i) => ({ cardId: `word:${i}`, ts: now - i * 60e3, grade: 'good' }));
  const s = summariseReviews(reviews, { now });
  assert.equal(s.recent.length, 40); assert.equal(s.recent[0].cardId, 'word:0'); assert.equal(s.recent[39].cardId, 'word:39');
});
