import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tzNow, dateStringDaysBefore, weekdayOf } from '../src/time';

test('tzNow reports the date and time in the requested timezone', () => {
  // 2026-07-02T01:30 UTC is still 2026-07-01 20:30 in Chicago (CDT, UTC-5).
  const d = new Date('2026-07-02T01:30:00Z');
  assert.deepEqual(tzNow('America/Chicago', d), { date: '2026-07-01', hour: 20, minute: 30 });
  assert.deepEqual(tzNow('UTC', d), { date: '2026-07-02', hour: 1, minute: 30 });
});

test('tzNow handles midnight without reporting hour 24', () => {
  const d = new Date('2026-07-02T05:00:00Z'); // midnight in Chicago
  assert.deepEqual(tzNow('America/Chicago', d), { date: '2026-07-02', hour: 0, minute: 0 });
});

test('tzNow during standard time (winter) uses the right offset', () => {
  // January: Chicago is CST (UTC-6).
  const d = new Date('2026-01-15T03:00:00Z');
  assert.deepEqual(tzNow('America/Chicago', d), { date: '2026-01-14', hour: 21, minute: 0 });
});

test('dateStringDaysBefore steps back within a month', () => {
  assert.equal(dateStringDaysBefore(1, '2026-07-15'), '2026-07-14');
});

test('dateStringDaysBefore crosses month and year boundaries', () => {
  assert.equal(dateStringDaysBefore(1, '2026-07-01'), '2026-06-30');
  assert.equal(dateStringDaysBefore(6, '2026-01-03'), '2025-12-28');
});

test('dateStringDaysBefore crosses a leap day', () => {
  assert.equal(dateStringDaysBefore(1, '2028-03-01'), '2028-02-29');
});

test('weekdayOf identifies days of the week', () => {
  assert.equal(weekdayOf('2026-07-12'), 0); // Sunday
  assert.equal(weekdayOf('2026-07-16'), 4); // Thursday
  assert.equal(weekdayOf('2026-07-18'), 6); // Saturday
});

test('four weeks before a Thursday is also a Thursday', () => {
  assert.equal(weekdayOf(dateStringDaysBefore(28, '2026-07-16')), 4);
});
