import { BridgeError } from '../types.ts';

/**
 * Utilitários compartilhados pelos repositórios: montagem segura de fragmentos de SQL
 * (só placeholders, nunca valores), leitura defensiva de colunas e validação de entrada.
 */

/**
 * Tamanho dos lotes das listas IN (...). O SQLite aceita 32766 parâmetros por statement;
 * 500 fica muito abaixo disso e mantém cada statement pequeno.
 */
export const IN_CHUNK_SIZE = 500;

export function chunk<T>(items: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "?, ?, ?" com `count` marcadores. O texto depende só da quantidade, nunca dos valores. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Cláusula que acompanha todo LIKE montado com likeContains. */
export const LIKE_ESCAPE = "ESCAPE '\\'";

/**
 * Padrão LIKE "contém", com os curingas do texto do usuário neutralizados: sem isso,
 * buscar "100%" casaria com qualquer coisa que contenha "100" e "_" casaria com
 * qualquer caractere. O valor continua indo por parâmetro.
 */
export function likeContains(text: string): string {
  return `%${text.replace(/\u0000/g, '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Texto de busca saneado, pronto para likeContains: sem caractere NUL, sem espaços nas
 * pontas e cortado em `maxChars`. Devolve '' quando não sobra nada para buscar (quem
 * chama deve então listar sem filtro, e não montar um LIKE '%%').
 *
 * O NUL sai porque o LIKE do SQLite trata o padrão como texto terminado em NUL: buscar
 * "\u0000" viraria o padrão "%", que casa com todas as linhas, e "abc\u0000def" buscaria
 * só por "abc".
 */
export function searchText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxChars);
}

/** Remove duplicatas preservando a ordem e descartando o que não é string. */
export function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string') seen.add(value);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Leitura defensiva
// ---------------------------------------------------------------------------

/** JSON de coluna que deveria ser array. Corrompido ou de outro tipo vira []. */
export function parseJsonArray(text: unknown): unknown[] {
  if (typeof text !== 'string' || text === '') return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** JSON de coluna que deveria ser objeto. Corrompido ou de outro tipo vira {}. */
export function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || text === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === 1n;
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------

export function invalid(message: string, details: Record<string, unknown> = {}): BridgeError {
  return new BridgeError('invalid_request', message, details);
}

/**
 * Converte uma data ISO para o formato canônico do toISOString() (UTC, milissegundos,
 * largura fixa). As consultas comparam datas como texto, e isso só é correto se todas
 * estiverem exatamente nesse formato: "2026-01-01T00:00:00Z" e
 * "2026-01-01T00:00:00.000Z" são o mesmo instante, mas textos diferentes.
 */
export function toIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`Data inválida em ${field}`, { field });
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(`Data inválida em ${field}`, { field });
  const iso = new Date(ms).toISOString();
  // Anos fora de 0000-9999 saem com sinal e seis dígitos, o que quebraria a ordenação.
  if (iso.length !== 24) throw invalid(`Data fora do intervalo suportado em ${field}`, { field });
  return iso;
}

export function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw invalid(`Campo obrigatório ausente: ${field}`, { field });
  const text = value.trim();
  if (text === '') throw invalid(`Campo obrigatório vazio: ${field}`, { field });
  if (text.length > maxLength) throw invalid(`Campo longo demais: ${field}`, { field, maxLength });
  return text;
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`Valor inválido em ${field}`, { field });
  }
  return value as T;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`Valor inválido em ${field}: esperado booleano`, { field });
  return value;
}

export function requireIntInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`Valor fora do intervalo em ${field} (${min} a ${max})`, { field, min, max });
  }
  return value;
}

/** LIMIT saneado: inteiro entre 0 e `max`. Valor inválido cai em `fallback`. */
export function clampLimit(value: unknown, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

/** OFFSET saneado: inteiro maior ou igual a zero. */
export function clampOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Erros do SQLite
// ---------------------------------------------------------------------------

type ConstraintKind = 'unique' | 'foreign_key' | 'check' | 'not_null';

/** Códigos estendidos do SQLite para violação de restrição. */
const CONSTRAINT_CODES: Record<ConstraintKind, readonly number[]> = {
  // SQLITE_CONSTRAINT_UNIQUE e SQLITE_CONSTRAINT_PRIMARYKEY
  unique: [2067, 1555],
  foreign_key: [787],
  check: [275],
  not_null: [1299],
};

export function isConstraintError(err: unknown, kind: ConstraintKind): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const errcode = (err as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && CONSTRAINT_CODES[kind].includes(errcode);
}
