'use strict';

function unfoldLines(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeIcs(value) {
  return String(value || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseProperty(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...parameterParts] = head.split(';');
  const params = {};
  for (const part of parameterParts) {
    const equal = part.indexOf('=');
    if (equal > 0) params[part.slice(0, equal).toUpperCase()] = part.slice(equal + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

function zonedDateToUtc(year, month, day, hour, minute, second, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, second).getTime();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(target));
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  return target - (represented - target);
}

function parseIcsDate(property) {
  if (!property) return null;
  const value = property.value.trim();
  const dateOnly = /^\d{8}$/.test(value) || property.params.VALUE === 'DATE';
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00', utc] = match;
  const parts = [Number(y), Number(mo), Number(d), Number(hh), Number(mm), Number(ss)];
  if (utc) return Date.UTC(...[parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]]);
  if (dateOnly) return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const tz = property.params.TZID;
  try { return zonedDateToUtc(...parts, tz); }
  catch (_) { return new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime(); }
}

function splitEvents(text) {
  const lines = unfoldLines(text);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line.trim().toUpperCase() === 'BEGIN:VEVENT') { current = []; continue; }
    if (line.trim().toUpperCase() === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (current) current.push(line);
  }
  return events;
}

function localParts(property) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(property?.value || '').trim());
  if (!match) return null;
  return {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0),
    utc: !!match[7], timeZone: property.params?.TZID || null,
    dateOnly: property.params?.VALUE === 'DATE' || !match[4],
  };
}

function occurrenceTimestamp(parts, date) {
  if (parts.utc) return Date.UTC(date.year, date.month - 1, date.day, parts.hour, parts.minute, parts.second);
  if (parts.timeZone) return zonedDateToUtc(date.year, date.month, date.day, parts.hour, parts.minute, parts.second, parts.timeZone);
  return new Date(date.year, date.month - 1, date.day, parts.hour, parts.minute, parts.second).getTime();
}

function parseRule(value) {
  const result = {};
  for (const part of String(value || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).toUpperCase()] = part.slice(index + 1).toUpperCase();
  }
  return result;
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseByDay(value) {
  return String(value || '').split(',').filter(Boolean).map((part) => {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part);
    return match ? { ordinal: match[1] ? Number(match[1]) : null, weekday: WEEKDAYS[match[2]] } : null;
  }).filter(Boolean);
}

function ordinalWeekdayInMonth(year, month, day, ordinal) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (ordinal > 0) return Math.floor((day - 1) / 7) + 1 === ordinal;
  const fromEnd = Math.floor((lastDay - day) / 7) + 1;
  return fromEnd === Math.abs(ordinal);
}

function ruleMatches(rule, date, base, dayOffset) {
  const freq = rule.FREQ;
  const interval = Math.max(1, Math.min(366, Number(rule.INTERVAL) || 1));
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const baseDate = new Date(Date.UTC(base.year, base.month - 1, base.day));
  const candidateDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const monthDelta = (date.year - base.year) * 12 + date.month - base.month;
  const yearDelta = date.year - base.year;
  const byDay = parseByDay(rule.BYDAY);
  const byMonth = rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : null;
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : null;
  const monthDayMatches = !byMonthDay || byMonthDay.some((n) => n > 0 ? date.day === n : date.day === new Date(Date.UTC(date.year, date.month, 0)).getUTCDate() + n + 1);
  const byDayMatches = !byDay.length || byDay.some((entry) => weekday === entry.weekday && (entry.ordinal == null || ordinalWeekdayInMonth(date.year, date.month, date.day, entry.ordinal)));
  const monthMatches = !byMonth || byMonth.includes(date.month);

  if (freq === 'DAILY') return dayOffset % interval === 0 && monthMatches && monthDayMatches && byDayMatches;
  if (freq === 'WEEKLY') {
    const wkst = WEEKDAYS[rule.WKST] ?? 1;
    const baseDay = Math.floor(baseDate.getTime() / 86_400_000);
    const candidateDay = Math.floor(candidateDate.getTime() / 86_400_000);
    const baseWeek = Math.floor((baseDay - ((baseDate.getUTCDay() - wkst + 7) % 7)) / 7);
    const candidateWeek = Math.floor((candidateDay - ((candidateDate.getUTCDay() - wkst + 7) % 7)) / 7);
    const weekdays = byDay.length ? byDay : [{ weekday: baseDate.getUTCDay() }];
    return (candidateWeek - baseWeek) % interval === 0 && weekdays.some((entry) => weekday === entry.weekday) && monthMatches && monthDayMatches;
  }
  if (freq === 'MONTHLY') {
    const defaultDay = !byMonthDay && !byDay.length ? date.day === base.day : true;
    return monthDelta % interval === 0 && defaultDay && monthMatches && monthDayMatches && byDayMatches;
  }
  if (freq === 'YEARLY') {
    const defaultDate = !byMonthDay && !byDay.length ? date.day === base.day && date.month === base.month : true;
    return yearDelta % interval === 0 && defaultDate && monthMatches && monthDayMatches && byDayMatches;
  }
  return false;
}

function parseCalendar(text, { now = Date.now(), daysAhead = 60, maxEvents = 500 } = {}) {
  const source = String(text || '');
  if (!/BEGIN:VCALENDAR/i.test(source)) throw new Error('This file is not a valid iCalendar feed.');
  const components = splitEvents(source);
  const rangeEnd = now + daysAhead * 86_400_000;
  const events = [];
  let recurringSkipped = 0;
  for (const lines of components) {
    const props = new Map();
    for (const line of lines) {
      const prop = parseProperty(line);
      if (!prop) continue;
      if (!props.has(prop.name)) props.set(prop.name, []);
      props.get(prop.name).push(prop);
    }
    const first = (name) => props.get(name)?.[0];
    if (String(first('STATUS')?.value || '').toUpperCase() === 'CANCELLED') continue;
    const startProp = first('DTSTART');
    const start = parseIcsDate(startProp);
    if (!Number.isFinite(start)) continue;
    const end = parseIcsDate(first('DTEND')) || (start + 60 * 60_000);
    const base = localParts(startProp);
    if (!base) continue;
    const baseEvent = {
      uid: unescapeIcs(first('UID')?.value || `${start}:${unescapeIcs(first('SUMMARY')?.value || 'event')}`),
      summary: unescapeIcs(first('SUMMARY')?.value || 'Untitled event').slice(0, 300),
      description: unescapeIcs(first('DESCRIPTION')?.value || '').slice(0, 2000),
      location: unescapeIcs(first('LOCATION')?.value || '').slice(0, 500),
      allDay: base.dateOnly,
    };
    const duration = Math.max(0, end - start);
    const ruleProperty = first('RRULE');
    const excluded = new Set();
    for (const property of props.get('EXDATE') || []) {
      for (const value of property.value.split(',')) {
        const stamp = parseIcsDate({ ...property, value });
        if (Number.isFinite(stamp)) excluded.add(stamp);
      }
    }

    const occurrences = [];
    if (!ruleProperty) {
      occurrences.push(start);
    } else {
      const rule = parseRule(ruleProperty.value);
      const supported = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ)
        && !['BYSETPOS', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].some((key) => rule[key]);
      if (!supported) {
        recurringSkipped++;
        continue;
      }
      const countLimit = Math.max(1, Math.min(5000, Number(rule.COUNT) || 5000));
      const until = rule.UNTIL ? parseIcsDate({ ...startProp, value: rule.UNTIL, params: {} }) : Infinity;
      const baseDay = Date.UTC(base.year, base.month - 1, base.day);
      const endParts = new Date(rangeEnd + (base.timeZone ? 2 * 86_400_000 : 0));
      const endDay = Date.UTC(endParts.getUTCFullYear(), endParts.getUTCMonth(), endParts.getUTCDate());
      let emitted = 0;
      let checked = 0;
      for (let day = baseDay; day <= endDay && checked < 50_000 && occurrences.length < maxEvents; day += 86_400_000) {
        checked++;
        const date = new Date(day);
        const dateParts = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
        const dayOffset = Math.round((day - baseDay) / 86_400_000);
        if (!ruleMatches(rule, dateParts, base, dayOffset)) continue;
        const stamp = occurrenceTimestamp(base, dateParts);
        if (stamp > until) break;
        emitted++;
        if (emitted > countLimit) break;
        if (!excluded.has(stamp) && stamp + duration >= now - 86_400_000 && stamp <= rangeEnd) occurrences.push(stamp);
      }
      if (checked >= 50_000) recurringSkipped++;
      // RDATE adds explicit occurrences to a recurring set.
      for (const property of props.get('RDATE') || []) {
        for (const value of property.value.split(',')) {
          const stamp = parseIcsDate({ ...property, value });
          if (Number.isFinite(stamp) && !excluded.has(stamp) && stamp + duration >= now - 86_400_000 && stamp <= rangeEnd) occurrences.push(stamp);
        }
      }
    }

    for (const stamp of [...new Set(occurrences)].sort((a, b) => a - b)) {
      if (stamp + duration < now - 86_400_000 || stamp > rangeEnd) continue;
      events.push({ ...baseEvent, uid: ruleProperty ? `${baseEvent.uid}::${stamp}` : baseEvent.uid, startAt: stamp, endAt: stamp + duration });
      if (events.length >= maxEvents) break;
    }
    if (events.length >= maxEvents) break;
  }
  events.sort((a, b) => a.startAt - b.startAt);
  return { events, recurringSkipped };
}

module.exports = { parseCalendar, parseIcsDate, unfoldLines, unescapeIcs };
