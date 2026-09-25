// scheduler.test.mjs — SM-2 variant transitions (site/js/scheduler.js, PLAN §5.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeCard, newCardState, previewIntervals, formatInterval, mulberry32,
  startOfDay, endOfToday, isDue, MINUTE, DAY, MAX_INTERVAL_DAYS,
} from '../../site/js/scheduler.js';

const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime();
const noFuzz = () => 0.5;
const review = (interval, extra = {}) => ({ ...newCardState(NOW), status: 'review', interval, ease: 2.5, reps: 5, ...extra });

test('new card: Again → 1 min learning', () => {
  const s = gradeCard(newCardState(NOW), 'again', NOW, noFuzz);
  assert.equal(s.status, 'learning');
  assert.equal(s.due - NOW, 1 * MINUTE);
  assert.equal(s.reps, 1);
  assert.equal(s.lastReview, NOW);
});

test('new card: Hard → 10 min learning, step unchanged', () => {
  const s = gradeCard(newCardState(NOW), 'hard', NOW, noFuzz);
  assert.equal(s.status, 'learning');
  assert.equal(s.due - NOW, 10 * MINUTE);
  assert.equal(s.step, 0);
});

test('new card: Good → 10 min step, then Good graduates to 1 day', () => {
  const a = gradeCard(newCardState(NOW), 'good', NOW, noFuzz);
  assert.equal(a.status, 'learning');
  assert.equal(a.step, 1);
  assert.equal(a.due - NOW, 10 * MINUTE);
  const b = gradeCard(a, 'good', NOW + 10 * MINUTE, noFuzz);
  assert.equal(b.status, 'review');
  assert.equal(b.interval, 1);
  assert.equal(b.due - (NOW + 10 * MINUTE), DAY);
});

test('new card: Easy → graduate at 4 days, ease 2.65', () => {
  const s = gradeCard(newCardState(NOW), 'easy', NOW, noFuzz);
  assert.equal(s.status, 'review');
  assert.equal(s.interval, 4);
  assert.equal(s.ease, 2.65);
});

test('accepts numeric grades 1..4 and a null state', () => {
  assert.equal(gradeCard(null, 4, NOW, noFuzz).interval, 4);
  assert.throws(() => gradeCard(null, 'meh', NOW));
});

test('review: Good → interval × ease', () => {
  const s = gradeCard(review(10), 'good', NOW, noFuzz);
  assert.equal(s.interval, 25);
  assert.equal(s.ease, 2.5);
});

test('review: Hard → max(old+1, old×1.2), ease −0.15', () => {
  const s = gradeCard(review(10), 'hard', NOW, noFuzz);
  assert.equal(s.interval, 12);
  assert.equal(s.ease, 2.35);
  const small = gradeCard(review(1), 'hard', NOW, noFuzz);
  assert.equal(small.interval, 2);
});

test('review: Easy → old × ease × 1.3, ease +0.15', () => {
  const s = gradeCard(review(10), 'easy', NOW, noFuzz);
  assert.equal(s.interval, Math.round(10 * 2.5 * 1.3));
  assert.equal(s.ease, 2.65);
});

test('review: Again → lapse, ease −0.2, 1 min, re-graduates at max(1, round(old×0.3))', () => {
  const lapsed = gradeCard(review(20), 'again', NOW, noFuzz);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.ease, 2.3);
  assert.equal(lapsed.status, 'learning');
  assert.equal(lapsed.due - NOW, MINUTE);
  const step = gradeCard(lapsed, 'good', NOW + MINUTE, noFuzz);
  assert.equal(step.status, 'learning');
  const regrad = gradeCard(step, 'good', NOW + 11 * MINUTE, noFuzz);
  assert.equal(regrad.status, 'review');
  assert.equal(regrad.interval, 6);
  assert.equal(regrad.lapseIvl, null);
  // Small intervals never re-graduate below 1 day.
  const tiny = gradeCard(gradeCard(gradeCard(review(1), 'again', NOW), 'good', NOW), 'good', NOW, noFuzz);
  assert.equal(tiny.interval, 1);
});

test('ease never drops below 1.3', () => {
  let s = review(10, { ease: 1.35 });
  s = gradeCard(s, 'again', NOW, noFuzz);
  assert.equal(s.ease, 1.3);
  s = gradeCard(review(10, { ease: 1.3 }), 'hard', NOW, noFuzz);
  assert.equal(s.ease, 1.3);
});

test('interval is capped at 365 days', () => {
  const s = gradeCard(review(300), 'easy', NOW, noFuzz);
  assert.equal(s.interval, MAX_INTERVAL_DAYS);
  assert.equal(gradeCard(review(365), 'good', NOW, noFuzz).interval, 365);
});

test('fuzz is ±5 % and deterministic for a seed', () => {
  const a = gradeCard(review(100), 'good', NOW, 42);
  const b = gradeCard(review(100), 'good', NOW, 42);
  assert.equal(a.interval, b.interval);
  const c = gradeCard(review(100), 'good', NOW, mulberry32(42));
  assert.equal(a.interval, c.interval);
  for (let seed = 1; seed < 50; seed++) {
    const s = gradeCard(review(100), 'good', NOW, seed);
    assert.ok(s.interval >= 237 && s.interval <= 263, `interval ${s.interval} within ±5 % of 250`);
  }
});

test('previewIntervals gives human labels', () => {
  assert.deepEqual(previewIntervals(newCardState(NOW), NOW), { again: '1m', hard: '10m', good: '10m', easy: '4d' });
  const r = previewIntervals(review(10), NOW);
  assert.deepEqual(r, { again: '1m', hard: '12d', good: '25d', easy: '1.1mo' });
  assert.equal(formatInterval(400), '1.1y');
  assert.equal(formatInterval(3 / 24), '3h');
});

test('day boundary at 04:00 local', () => {
  const at3am = new Date(2026, 8, 25, 3, 0).getTime();
  const at5am = new Date(2026, 8, 25, 5, 0).getTime();
  assert.equal(startOfDay(at3am), new Date(2026, 8, 24, 4, 0).getTime());
  assert.equal(startOfDay(at5am), new Date(2026, 8, 25, 4, 0).getTime());
  assert.equal(endOfToday(at5am), new Date(2026, 8, 26, 4, 0).getTime());
  const dueTonight = { ...review(1), due: new Date(2026, 8, 25, 23, 0).getTime() };
  assert.equal(isDue(dueTonight, at5am), true);
  const dueTomorrow = { ...review(1), due: new Date(2026, 8, 26, 5, 0).getTime() };
  assert.equal(isDue(dueTomorrow, at5am), false);
  assert.equal(isDue(newCardState(NOW), NOW), false);
});
