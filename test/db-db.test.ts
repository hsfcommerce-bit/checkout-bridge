import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';

const open: Db[] = [];
const tempDirs: string[] = [];

function memory(): Db {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER)');
  open.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
  tempDirs.push(dir);
  return dir;
}

function names(db: Db): string[] {
  return db.all<{ name: string }>('SELECT name FROM t ORDER BY id').map((row) => row.name);
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('aplica os pragmas em banco em memória (sem WAL)', () => {
    const db = memory();
    assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
    assert.equal(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout, 5000);
    assert.equal(db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous, 1);
    assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'memory');
  });

  it('cria o diretório pai, usa WAL em arquivo e persiste entre aberturas', () => {
    const path = join(tempDir(), 'a', 'b', 'bridge.db');
    const first = openDatabase(path);
    open.push(first);
    assert.ok(existsSync(path));
    assert.equal(first.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
    assert.equal(first.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER)');
    first.run('INSERT INTO t (name) VALUES (?)', ['persistido']);
    first.close();

    const second = openDatabase(path);
    open.push(second);
    assert.deepEqual(names(second), ['persistido']);
  });

  it('chaves estrangeiras valem de fato', () => {
    const db = memory();
    db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, t_id INTEGER NOT NULL REFERENCES t(id) ON DELETE CASCADE)');
    assert.throws(() => db.run('INSERT INTO child (t_id) VALUES (?)', [999]), /FOREIGN KEY/);
    db.run('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'pai']);
    db.run('INSERT INTO child (t_id) VALUES (?)', [1]);
    db.run('DELETE FROM t WHERE id = ?', [1]);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM child')?.n, 0);
  });

  it('close pode ser chamado duas vezes; usar depois de fechar lança', () => {
    const db = openDatabase(':memory:');
    db.close();
    db.close();
    assert.throws(() => db.exec('SELECT 1'));
  });
});

describe('run / get / all', () => {
  it('run devolve changes e lastInsertRowid como números', () => {
    const db = memory();
    const first = db.run('INSERT INTO t (name, n) VALUES (?, ?)', ['a', 1]);
    assert.deepEqual(first, { changes: 1, lastInsertRowid: 1 });
    db.run('INSERT INTO t (name, n) VALUES (?, ?)', ['b', 2]);
    const updated = db.run('UPDATE t SET n = n + 1');
    assert.equal(updated.changes, 2);
    assert.equal(typeof updated.lastInsertRowid, 'number');
  });

  it('get devolve undefined sem linha e all devolve lista vazia', () => {
    const db = memory();
    assert.equal(db.get('SELECT * FROM t WHERE id = ?', [1]), undefined);
    assert.deepEqual(db.all('SELECT * FROM t'), []);
  });

  it('aceita parâmetros posicionais e nomeados, inclusive null, bigint e bytes', () => {
    const db = memory();
    db.run('INSERT INTO t (name, n) VALUES (:name, :n)', { name: 'nomeado', n: null });
    db.run('INSERT INTO t (name, n) VALUES (?, ?)', ['grande', 9007199254740993n]);
    assert.equal(db.get<{ n: number | null }>('SELECT n FROM t WHERE name = :name', { name: 'nomeado' })?.n, null);
    assert.equal(db.get<{ s: string }>('SELECT CAST(n AS TEXT) AS s FROM t WHERE name = ?', ['grande'])?.s, '9007199254740993');
    const bytes = db.get<{ b: Uint8Array }>('SELECT ? AS b', [new Uint8Array([1, 2, 3])])?.b;
    assert.deepEqual([...(bytes ?? [])], [1, 2, 3]);
  });

  it('valores hostis entram como dado, nunca como SQL', () => {
    const db = memory();
    const hostile = [
      "x'); DROP TABLE t; --",
      '" OR 1=1 --',
      "'; DELETE FROM t; --",
      'a\u0000b',
      '%_\\',
      '‮rtl',
    ];
    for (const value of hostile) db.run('INSERT INTO t (name) VALUES (?)', [value]);
    assert.deepEqual(names(db), hostile);
    assert.equal(db.all('SELECT * FROM t WHERE name = ?', ["' OR '1'='1"]).length, 0);
    assert.equal(db.get<{ name: string }>('SELECT name FROM t WHERE name = :v', { v: hostile[0] ?? '' })?.name, hostile[0]);
  });

  it('reaproveita statements e aguenta muitos textos de SQL distintos', () => {
    const db = memory();
    for (let i = 0; i < 3; i += 1) db.run('INSERT INTO t (name) VALUES (?)', [`n${i}`]);
    // Mais textos distintos do que o cache comporta: os antigos saem e tudo segue certo.
    for (let i = 1; i <= 600; i += 1) {
      const marks = Array.from({ length: (i % 7) + 1 }, () => '?').join(', ');
      const sql = `SELECT COUNT(*) AS n FROM t WHERE id IN (${marks}) /* ${i} */`;
      const params = Array.from({ length: (i % 7) + 1 }, (_, k) => k + 1);
      assert.equal(db.get<{ n: number }>(sql, params)?.n, Math.min(3, params.length));
    }
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')?.n, 3);
  });
});

describe('transaction', () => {
  it('confirma no sucesso e devolve o valor de fn', () => {
    const db = memory();
    const result = db.transaction(() => {
      db.run('INSERT INTO t (name) VALUES (?)', ['a']);
      db.run('INSERT INTO t (name) VALUES (?)', ['b']);
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(names(db), ['a', 'b']);
  });

  it('desfaz tudo quando fn lança e repassa o mesmo erro', () => {
    const db = memory();
    const boom = new Error('falhou no meio');
    assert.throws(
      () =>
        db.transaction(() => {
          db.run('INSERT INTO t (name) VALUES (?)', ['a']);
          throw boom;
        }),
      (err) => err === boom,
    );
    assert.deepEqual(names(db), []);
  });

  it('desfaz também quando a falha é do próprio SQLite', () => {
    const db = memory();
    assert.throws(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (name) VALUES (?)', ['a']);
        db.run('INSERT INTO t (name) VALUES (?)', [null]);
      }),
    );
    assert.deepEqual(names(db), []);
  });

  it('volta a funcionar depois de uma transação que falhou', () => {
    const db = memory();
    assert.throws(() => db.transaction(() => { throw new Error('x'); }));
    db.transaction(() => db.run('INSERT INTO t (name) VALUES (?)', ['depois']));
    assert.deepEqual(names(db), ['depois']);
  });

  it('aninhada: entra na transação externa e só o COMMIT externo grava', () => {
    const db = memory();
    assert.throws(() =>
      db.transaction(() => {
        db.transaction(() => db.run('INSERT INTO t (name) VALUES (?)', ['interna']));
        // A interna "terminou", mas nada pode estar gravado se a externa falhar.
        throw new Error('externa falhou');
      }),
    );
    assert.deepEqual(names(db), []);

    db.transaction(() => {
      db.run('INSERT INTO t (name) VALUES (?)', ['externa']);
      db.transaction(() => {
        db.run('INSERT INTO t (name) VALUES (?)', ['interna']);
        db.transaction(() => db.run('INSERT INTO t (name) VALUES (?)', ['mais interna']));
      });
    });
    assert.deepEqual(names(db), ['externa', 'interna', 'mais interna']);
  });

  it('aninhada que falha desfaz só o trecho interno quando a externa trata o erro', () => {
    const db = memory();
    db.transaction(() => {
      db.run('INSERT INTO t (name) VALUES (?)', ['antes']);
      assert.throws(() =>
        db.transaction(() => {
          db.run('INSERT INTO t (name) VALUES (?)', ['interna perdida']);
          throw new Error('interna falhou');
        }),
      );
      db.run('INSERT INTO t (name) VALUES (?)', ['depois']);
    });
    assert.deepEqual(names(db), ['antes', 'depois']);
  });

  it('aninhada que falha sem tratamento desfaz a transação inteira', () => {
    const db = memory();
    assert.throws(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (name) VALUES (?)', ['externa']);
        db.transaction(() => {
          db.run('INSERT INTO t (name) VALUES (?)', ['interna']);
          throw new Error('interna falhou');
        });
      }),
    );
    assert.deepEqual(names(db), []);
  });

  it('entra em uma transação aberta à mão com exec', () => {
    const db = memory();
    db.exec('BEGIN');
    db.transaction(() => db.run('INSERT INTO t (name) VALUES (?)', ['a']));
    db.exec('ROLLBACK');
    assert.deepEqual(names(db), []);
  });

  it('recusa função assíncrona e não grava nada', async () => {
    const db = memory();
    let pending: Promise<unknown> | undefined;
    assert.throws(
      () =>
        db.transaction(() => {
          db.run('INSERT INTO t (name) VALUES (?)', ['a']);
          pending = Promise.resolve();
          return pending;
        }),
      /síncrona/,
    );
    await pending;
    assert.deepEqual(names(db), []);
  });

  it('BEGIN IMMEDIATE: outra conexão não grava enquanto a transação está aberta', () => {
    const path = join(tempDir(), 'lock.db');
    const first = openDatabase(path);
    const second = openDatabase(path);
    open.push(first, second);
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER)');
    // Sem espera na segunda conexão, para o teste não ficar parado no busy_timeout.
    second.exec('PRAGMA busy_timeout = 0');

    first.transaction(() => {
      // Ainda não houve escrita na primeira; a trava vem do IMMEDIATE, não do INSERT.
      assert.throws(() => second.run('INSERT INTO t (name) VALUES (?)', ['intrusa']), /locked|busy/i);
      first.run('INSERT INTO t (name) VALUES (?)', ['dona']);
    });
    second.run('INSERT INTO t (name) VALUES (?)', ['depois']);
    assert.deepEqual(names(first), ['dona', 'depois']);
  });
});
