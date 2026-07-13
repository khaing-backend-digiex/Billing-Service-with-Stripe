/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testMatch: ["**/*.spec.ts"],
  setupFiles: ["<rootDir>/test/setup.ts"],
  // src dùng cả alias "@/..." (tsconfig paths) lẫn import tuyệt đối "src/..." (baseUrl)
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^src/(.*)$": "<rootDir>/src/$1",
  },
  // Chạy trên DB thật (Neon) → tuần tự để các suite không giẫm lên nhau,
  // timeout rộng vì mỗi query là 1 network roundtrip.
  maxWorkers: 1,
  testTimeout: 60000,
  // pg Pool trong PrismaService giữ socket mở sau $disconnect → thoát cưỡng bức
  forceExit: true,
};
