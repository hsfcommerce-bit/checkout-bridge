import { isoNow } from '../lib/clock.ts';
import { randomId } from '../lib/crypto.ts';
import type { BoardCard, BoardColumn, BoardRepo, Clock } from '../types.ts';
import type { Db } from './db.ts';
import { invalid, requireText, textOrNull } from './util.ts';

/** Quadro de operações: colunas livres e um cartão por vitrine (ver BoardRepo em types.ts). */
export function createBoardRepo(db: Db, deps: { clock: Clock }): BoardRepo {
  const { clock } = deps;
  const MAX_NOTE = 2000;

  function columns(): BoardColumn[] {
    return db.all<{ id: string; name: string; position: number }>('SELECT id, name, position FROM board_columns ORDER BY position, id');
  }

  type Row = { store_id: string; column_id: string | null; position: number; note: string; title: string; updated_at: string };
  function mapCard(row: Row): BoardCard {
    return { storeId: row.store_id, columnId: textOrNull(row.column_id), position: Number(row.position), note: row.note ?? '', title: row.title ?? '', updatedAt: row.updated_at };
  }

  return {
    columns,

    addColumn(name) {
      const clean = requireText(name, 'name', 60);
      const next = Number(db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM board_columns')?.n ?? 0);
      const column = { id: randomId('col'), name: clean, position: next };
      db.run('INSERT INTO board_columns (id, name, position) VALUES (?, ?, ?)', [column.id, column.name, column.position]);
      return column;
    },

    renameColumn(id, name) {
      const clean = requireText(name, 'name', 60);
      if (db.run('UPDATE board_columns SET name = ? WHERE id = ?', [clean, id]).changes === 0) throw invalid('Coluna não encontrada', { field: 'id' });
    },

    deleteColumn(id) {
      db.transaction(() => {
        db.run('UPDATE board_cards SET column_id = NULL, updated_at = ? WHERE column_id = ?', [isoNow(clock), id]);
        db.run('DELETE FROM board_columns WHERE id = ?', [id]);
      });
    },

    cards() {
      return db
        .all<Row>('SELECT store_id, column_id, position, note, title, updated_at FROM board_cards ORDER BY position, store_id')
        .map(mapCard);
    },

    card(storeId) {
      const row = db.get<Row>('SELECT store_id, column_id, position, note, title, updated_at FROM board_cards WHERE store_id = ?', [storeId]);
      return row ? mapCard(row) : null;
    },

    moveCard(storeId, columnId, position) {
      if (columnId !== null && db.get('SELECT id FROM board_columns WHERE id = ?', [columnId]) === undefined) {
        throw invalid('Coluna não encontrada', { field: 'columnId' });
      }
      const pos = Number.isSafeInteger(position) && position >= 0 ? position : 0;
      db.run(
        `INSERT INTO board_cards (store_id, column_id, position, note, updated_at) VALUES (?, ?, ?, '', ?)
         ON CONFLICT (store_id) DO UPDATE SET column_id = excluded.column_id, position = excluded.position, updated_at = excluded.updated_at`,
        [storeId, columnId, pos, isoNow(clock)],
      );
    },

    setTitle(storeId, title) {
      const clean = typeof title === 'string' ? title.trim().slice(0, 120) : '';
      db.run(
        `INSERT INTO board_cards (store_id, column_id, position, note, title, updated_at) VALUES (?, NULL, 0, '', ?, ?)
         ON CONFLICT (store_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
        [storeId, clean, isoNow(clock)],
      );
    },

    setNote(storeId, note) {
      const clean = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '';
      db.run(
        `INSERT INTO board_cards (store_id, column_id, position, note, updated_at) VALUES (?, NULL, 0, ?, ?)
         ON CONFLICT (store_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
        [storeId, clean, isoNow(clock)],
      );
    },
  };
}
