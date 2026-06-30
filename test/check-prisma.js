require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

// Try with adapter approach for Prisma v7
try {
  // Check if pg adapter is available
  const pg = require('pg');
  const Pool = pg.Pool;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  // Try prisma/pg adapter
  let adapter;
  try {
    const { PrismaPg } = require('@prisma/pg');
    adapter = new PrismaPg(pool);
    console.log('Using @prisma/pg adapter');
  } catch (e) {
    console.log('@prisma/pg not available:', e.message);
  }

  if (adapter) {
    const p = new PrismaClient({ adapter });
    console.log('PrismaClient created with adapter');
    p.$connect().then(() => {
      console.log('Connected!');
      return p.user.count();
    }).then(count => {
      console.log('User count:', count);
      return p.$disconnect();
    }).catch(e => console.error('Connect error:', e.message));
  } else {
    // Fallback: try empty object
    const p = new PrismaClient({});
    console.log('PrismaClient created with empty opts');
  }
} catch (e) {
  console.error('Error:', e.message);
}
