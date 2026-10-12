import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { parseAuthEnv } from "@/lib/env";

const globalDatabase = globalThis as typeof globalThis & {
  productHubPrisma?: PrismaClient;
};

function createPrismaClient() {
  const env = parseAuthEnv();
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  return new PrismaClient({ adapter });
}

export const prisma = globalDatabase.productHubPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalDatabase.productHubPrisma = prisma;
}
