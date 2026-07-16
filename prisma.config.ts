import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),

  migrations: {
    // Prisma 7 BỎ QUA `prisma.seed` trong package.json khi có file config này — seed phải
    // khai ở đây, nếu không `prisma db seed` báo "No seed command configured" và
    // `migrate reset` dựng ra một DB rỗng catalog (im lặng, không lỗi).
    seed: 'ts-node prisma/seed.ts',
  },

  datasource: {
    url: process.env.DATABASE_URL,
    // `migrate dev` và `migrate diff --from-migrations` cần một DB rỗng để replay lịch sử
    // migration rồi so với schema. Neon cho tạo nhiều database trong cùng project:
    //   CREATE DATABASE prisma_shadow;
    // Prisma tự xoá/tạo lại nội dung DB này — đừng trỏ vào DB có dữ liệu.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
