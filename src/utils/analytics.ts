import analyticsRules from '../../configs/analytics-events.json';

type AnalyticsPayload = Record<string, string | number | boolean | undefined>;

const allowed = new Set<string>(analyticsRules.allowedParameters);
const forbidden = new Set<string>(analyticsRules.forbiddenParameters);

export function sanitizeAnalyticsPayload(payload: AnalyticsPayload): AnalyticsPayload {
  return Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      return value !== undefined && allowed.has(key) && !forbidden.has(key);
    }),
  );
}
