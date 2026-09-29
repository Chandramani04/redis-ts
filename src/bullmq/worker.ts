// worker is run by a seperate process and is responsible for processing jobs from the queue

import { Redis } from "ioredis";
import { config } from "../config.js";
import { Worker } from "bullmq";
import type { EmailJobData } from "./queue.js";

const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

// create a worker to process jobs from the queue
const emailWorker = new Worker<EmailJobData>(
  "emailQueue",
  async (job) => {
    const { userId, email } = job.data;

    // Simulate sending a welcome email; replace this with an email provider call.
    console.log(`Sending welcome email to ${email} for user ${userId}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log(`Welcome email sent to ${email}`);
  },
  { connection, concurrency: 5 },
);

emailWorker.on("error", (error) => {
  console.error("Email worker error:", error);
});
