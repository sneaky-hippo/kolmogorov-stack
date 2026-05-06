// Vercel serverless adapter — wraps the Express app for the platform.
// Note: Vercel's filesystem is read-only at runtime; for production deploy,
// swap data/store.js for a managed store (Postgres / Redis). The Express app
// stays unchanged; this file just re-exports it.
import { app } from '../server.js';
export default app;
