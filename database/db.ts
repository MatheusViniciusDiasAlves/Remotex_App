/** Acesso ao PostgreSQL (pool de conexões + transações). */
import pg from 'pg';

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
    this.pool.on('error', (err) => console.error('[db] erro em conexão ociosa', err.message));
  }

  query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  async one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.query<T>(text, params);
    return r.rows[0] ?? null;
  }

  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
