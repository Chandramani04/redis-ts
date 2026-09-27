import { config as loadEnv } from "dotenv";

loadEnv();

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error("DATABASE_URL is not defined in the environment variables.");
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not defined in the environment variables.");
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbUrl,
  redisUrl,
} as const;
