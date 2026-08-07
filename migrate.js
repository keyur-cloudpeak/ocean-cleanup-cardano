import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;

async function migrate() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const sql = fs.readFileSync('db/schema.sql', 'utf8');
        await client.query(sql);
        console.log('Migration successful');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await client.end();
    }
}

migrate();
