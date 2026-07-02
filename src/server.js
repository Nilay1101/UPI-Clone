import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Persist to a file so accounts survive restarts. Override with DATABASE_PATH.
const dbPath =
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'upi.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const store = createStore({ dbPath });
const app = createApp(store);

app.listen(PORT, () => {
  console.log(`UPI-Clone API listening on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});
