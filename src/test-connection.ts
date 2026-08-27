import { pool } from "./db";

async function testConnection() {
    const result = await pool.query("SELECT * FROM balances");
    console.log("Connected! Balances:");
    console.log(result.rows);
    await pool.end();
}

testConnection();