import pg from 'pg';

const { Pool } = pg;

export interface DbQueryResult<Row = unknown> {
  rows: Row[];
  rowCount?: number | null;
}

export interface DbExecutor {
  query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>>;
}

export interface DbTransactionClient extends DbExecutor {
  release(): void;
}

export interface DbPool extends DbExecutor {
  connect(): Promise<DbTransactionClient>;
}

export function createPool(connectionString = process.env.DATABASE_URL): DbPool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString }) as DbPool;
}

export async function withTransaction<T>(pool: DbPool, run: (client: DbTransactionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
