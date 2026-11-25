/**
 * One JSON object per line. Fields are identifiers, codes and counts only: never
 * document text, titles, file names or manifest content (engineering rule 11).
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

function write(level: 'info' | 'warn' | 'error', event: string, fields: LogFields): void {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => {
    write('info', event, fields);
  },
  warn: (event: string, fields: LogFields = {}) => {
    write('warn', event, fields);
  },
  error: (event: string, fields: LogFields = {}) => {
    write('error', event, fields);
  },
};

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'UNKNOWN';
}
