import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl);

redis.on("connect", () => {
  console.log("Connected to Redis");
});

redis.on("error", (err) => {
  console.error("Redis error:", err);
});
