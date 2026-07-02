import { createApp } from './app.js';
import { createStore } from './store.js';

const PORT = process.env.PORT || 3000;

const store = createStore();
const app = createApp(store);

app.listen(PORT, () => {
  console.log(`UPI-Clone API listening on http://localhost:${PORT}`);
});
