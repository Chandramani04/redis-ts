import { Queue } from "bullmq";
import { redis } from "../redis.js";

export interface EmailJobData {
  userId: number;
  email: string;
}

export const emailQueue = new Queue<EmailJobData>("emailQueue", {
  connection: redis,
});
