'use strict';

function minutesOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isScheduleActive(schedule, date = new Date()) {
  if (!schedule || !schedule.enabled) return false;
  const start = minutesOfDay(schedule.start), end = minutesOfDay(schedule.end);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function isFocusActive(settings, date = new Date()) {
  return !!settings?.focus?.enabled || isScheduleActive(settings?.focus?.schedule, date);
}

function evaluateNotification(notification, settings, { paused = false, now = new Date() } = {}) {
  const appId = String(notification.appId || notification.app || 'unknown');
  const rule = settings?.apps?.[appId] || {};
  const priority = rule.priority === true;
  let status = 'shown';

  if (settings?.general?.notificationsEnabled === false) status = 'notifications-disabled';
  else if (rule.enabled === false) status = 'app-blocked';
  else if (paused) status = 'paused';
  else if (isFocusActive(settings, now) && !(priority && settings?.focus?.allowPriority !== false)) status = 'focus-muted';

  const defaultDuration = Number(settings?.notifications?.defaultDurationSeconds) || 7;
  const durationSeconds = Number(rule.durationSeconds) || defaultDuration;
  return {
    display: status === 'shown',
    status,
    priority,
    durationMs: Math.max(3, Math.min(30, durationSeconds)) * 1000,
  };
}

module.exports = { minutesOfDay, isScheduleActive, isFocusActive, evaluateNotification };
