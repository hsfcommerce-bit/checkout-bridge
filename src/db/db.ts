import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

/**
 * Acesso ao SQLite (node:sqlite, síncrono) com cache de statements e transações.
 *
 * Regra de ouro deste módulo e de quem o usa: valor nunca entra no texto do SQL. Tudo o
 * que vem de fora vai por parâmetro; nomes de coluna e ordenações dinâmicas só podem sair
 * de listas fixas no código.
 */

export type SqlParams =
  | Array<string | number | bigint | null | Uint8Array>
  | Record<string, string | number | bigint | null | Uint8Array>;

export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number };
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  /**
   * BEGIN IMMEDIATE / COMMIT, com ROLLBACK se fn lançar. Chamadas aninhadas entram na
   * transação externa (por SAVEPOINT): só o COMMIT externo torna algo durável, e uma
   * falha interna desfaz apenas o trecho interno antes de ser relançada.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Limite do cache de statements. As consultas com lista IN (...) geram um texto por
 * tamanho de lista; sem limite, o cache cresceria com a variedade de tamanhos.
 */
const MAX_CACHED_STATEMENTS = 256;

export function openDatabase(path: string): Db {
  const inMemory = path === ':memory:';
  if (!inMemory) {
    // O SQLite cria o arquivo, mas não o diretório onde ele fica.
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new DatabaseSync(path);
  // WAL não existe para banco em memória (o pragma devolveria "memory").
  if (!inMemory) database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA synchronous = NORMAL');

  // O Map preserva a ordem de inserção e cada uso reinsere a chave no fim; a primeira da
  // iteração é sempre a usada há mais tempo.
  const statements = new Map<string, StatementSync>();
  let depth = 0;
  let savepointSeq = 0;

  function prepare(sql: string): StatementSync {
    let statement = statements.get(sql);
    if (statement) {
      statements.delete(sql);
    } else {
      statement = database.prepare(sql);
      if (statements.size >= MAX_CACHED_STATEMENTS) {
        const oldest = statements.keys().next();
        if (!oldest.done) statements.delete(oldest.value);
      }
    }
    statements.set(sql, statement);
    return statement;
  }

  function rollbackQuietly(sql: string): void {
    try {
      database.exec(sql);
    } catch {
      // O SQLite já pode ter desfeito a transação por conta própria (disco cheio, por
      // exemplo). O erro que interessa é o original, relançado por quem chamou.
    }
  }

  function assertSync(result: unknown): void {
    if (typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
      // Uma função async "terminaria" antes de fazer o trabalho, e o COMMIT sairia vazio
      // enquanto as gravações aconteceriam depois, fora de qualquer transação.
      throw new Error('A função passada a transaction() deve ser síncrona');
    }
  }

  const db: Db = {
    exec(sql) {
      database.exec(sql);
    },

    run(sql, params) {
      const statement = prepare(sql);
      // Posicionais viram argumentos soltos; nomeados vão como um único objeto.
      const result =
        params === undefined
          ? statement.run()
          : Array.isArray(params)
            ? statement.run(...params)
            : statement.run(params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },

    get<T>(sql: string, params?: SqlParams): T | undefined {
      const statement = prepare(sql);
      const row =
        params === undefined
          ? statement.get()
          : Array.isArray(params)
            ? statement.get(...params)
            : statement.get(params);
      return row === undefined || row === null ? undefined : (row as T);
    },

    all<T>(sql: string, params?: SqlParams): T[] {
      const statement = prepare(sql);
      const rows =
        params === undefined
          ? statement.all()
          : Array.isArray(params)
            ? statement.all(...params)
            : statement.all(params);
      return rows as T[];
    },

    transaction<T>(fn: () => T): T {
      // depth cobre as transações abertas por aqui; isTransaction cobre um BEGIN feito à
      // mão via exec(). Nos dois casos o aninhamento vira SAVEPOINT.
      if (depth > 0 || database.isTransaction) {
        savepointSeq += 1;
        const name = `bridge_sp_${savepointSeq}`;
        database.exec(`SAVEPOINT ${name}`);
        depth += 1;
        try {
          const result = fn();
          assertSync(result);
          database.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          rollbackQuietly(`ROLLBACK TO ${name}`);
          rollbackQuietly(`RELEASE ${name}`);
          throw err;
        } finally {
          depth -= 1;
        }
      }

      // IMMEDIATE pega a trava de escrita já no início: duas transações do tipo "ler e
      // depois gravar" não se intercalam, nem entre processos diferentes.
      database.exec('BEGIN IMMEDIATE');
      depth += 1;
      try {
        const result = fn();
        assertSync(result);
        database.exec('COMMIT');
        return result;
      } catch (err) {
        if (database.isTransaction) rollbackQuietly('ROLLBACK');
        throw err;
      } finally {
        depth -= 1;
      }
    },

    close() {
      statements.clear();
      if (database.isOpen) database.close();
    },
  };

  return db;
}
