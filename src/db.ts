import { Pool } from "pg";

export const pool = new Pool({
    user: "exchange",
    password: "exchange",
    host: "localhost",
    port: 5432,
    database: "db_exchange",
});