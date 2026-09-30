import { loadEnv } from "../config/env.js";
import { closeDatabase, openDatabase } from "./client.js";

const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH, { migrate: true });
closeDatabase(db);
console.log(`Migrations applied to ${env.DATABASE_PATH}`);
