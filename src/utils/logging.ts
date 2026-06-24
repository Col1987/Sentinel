const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const currentLevel = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
const rank = (l: Level) => LEVELS.indexOf(l);

function log(level: Level, ...args: unknown[]): void {
  if (rank(level) < rank(currentLevel)) return;
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
};
