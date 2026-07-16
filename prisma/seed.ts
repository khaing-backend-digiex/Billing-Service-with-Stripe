import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding Product AI...');
  const productAI = await prisma.product.upsert({
    where: { code: 'AI' },
    update: {},
    create: {
      code: 'AI',
      name: 'Artificial Intelligence',
      isActive: true,
    },
  });
  console.log('Product AI seeded:', productAI.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
