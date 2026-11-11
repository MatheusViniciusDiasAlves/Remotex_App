/** CLI: aplica as migrações pendentes no banco definido em DATABASE_URL. */
import { Database } from '@remotex/database/db';
import { migrate } from '@remotex/database/migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Defina DATABASE_URL');
  process.exit(1);
}
const db = new Database(url, 1);
migrate(db)
  .then((done) => console.log(done.length ? `Migrações aplicadas: ${done.join(', ')}` : 'Banco já está atualizado'))
  .catch((err) => {
    console.error('Falha na migração:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
