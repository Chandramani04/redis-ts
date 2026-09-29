import bcrypt from "bcrypt";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import type { IUser } from "./types.js";
import { ALL } from "node:dns";
import type { Result } from "ioredis";
import { emailQueue } from "./bullmq/queue.js";

const port = config.port || 3000;
const app = express();

// middleware
app.use(express.json()); // parse incoming JSON requests
app.use(express.urlencoded({ extended: true })); // parse incoming URL-encoded requests
// app.use(rateLimiter); // apply rate limiting middleware to all routes : not recommended

app.get("/", (req: Request, res: Response) => {
  return res.status(200).json({
    message: "hello from 3000 on mac",
    port,
    redisUrl: config.redisUrl,
    dbUrl: config.dbUrl,
  });
});

app.get("/health", async (req: Request, res: Response) => {
  try {
    const [, redisStatus] = await Promise.all([pool.query("SELECT 1"), redis.ping()]);

    return res.status(200).json({
      status: "ok",
      postgres: "connected",
      redis: redisStatus === "PONG" ? "connected" : "disconnected",
    });
  } catch (error) {
    console.error("Health check error:", error);
    return res.status(500).json({
      status: "error",
      message: "Health check failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// #1. CACHE-ASIDE pattern for user creation and retrieval
app.post("/create", async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    // check if user already exists
    const existingUser = await pool.query("select id from users where email = $1", [email]);

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        message: "user already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await pool.query<Omit<IUser, "password_hash">>(
      `
      insert into users (name , email, password_hash) values
      ( $1, $2, $3) returning id, name, email, created_at, updated_at
      `,
      [name, email, passwordHash],
    );

    return res.status(200).json({
      message: "user created successfully",
      user: user.rows[0],
    });
  } catch (error) {
    return res.status(500).json({
      message: "error creating user",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/user/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    // CACHE-ASIDE redis cache pattern

    // step 1 : check if user exists in redis cache
    const cachedUser = await redis.get(`user:${id}`);
    if (cachedUser) {
      return res.status(200).json({
        message: "user fetched from cache",
        user: JSON.parse(cachedUser),
      });
    }

    // step 2 : if not found in cache, fetch from database
    // <Omit<IUser, "password_hash">>
    const user = await pool.query(
      `
      select id, name, email, created_at, updated_at from users where id = $1
      `,
      [id],
    );

    // step 3 : if user not found in database, return 404
    if (!user.rows.length) {
      return res.status(404).json({
        message: "user not found",
      });
    }

    // step 4 : if user found in database, cache it in redis for future requests
    await redis.set(`user:${id}`, JSON.stringify(user.rows[0]), "EX", 300); // cache for 300 seconds

    // step 5 : return the user
    return res.status(200).json({
      message: "user fetched from database",
      user_1_row: user.rows[0],
      all_rows: user.rows,
    });
  } catch (error) {
    return res.status(500).json({
      message: "error fetching user",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// #2 . OTP generation and verification
function genOTP(): string {
  const otp = Math.floor(100000 + Math.random() * 900000); // generates a 6-digit number
  return otp.toString();
}

app.post("/send-otp", async (req: Request, res: Response) => {
  try {
    const email = req.body.email;
    const otp = genOTP();

    // store the otp in redis with a TTL of 2 minutes
    await redis.set(`user:${email}`, otp, "EX", 120);

    // send the otp to the user via email (this is a placeholder, implement actual email sending logic)
    return res.status(200).json({
      message: "otp sent successfully",
      email,
      otp, // in real application, you wouldn't send the otp back in the response
    });
  } catch (err) {
    return res.status(500).json({
      message: "error sending otp",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/verify-otp", async (req: Request, res: Response) => {
  try {
    // get the email and otp from the body
    const { email, otp } = req.body;

    if (typeof email !== "string" || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: "Invalid request" });
    }

    // get the otp from redis
    const cachedOtp = await redis.get(`user:${email}`);

    if (cachedOtp === null) {
      return res.status(400).json({
        message: "otp expired or not found",
      });
    }

    if (cachedOtp !== otp) {
      return res.status(400).json({
        message: "invalid otp",
        cacheOtpType: typeof cachedOtp,
        cacheOtpValue: cachedOtp,
        requestOtpType: typeof otp,
        requestOtpValue: otp,
      });
    }

    await redis.del(`user:${email}`);

    return res.status(200).json({
      message: "otp verified successfully",
      cacheOtpType: typeof cachedOtp,
      cacheOtpValue: cachedOtp,
      requestOtpType: typeof otp,
      requestOtpValue: otp,
    });
  } catch (err) {
    return res.status(500).json({
      message: "invalid otp",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// #3.  Rate limiting middleware through Redis

const WINDOW_SECOND = 60; // 1 minute
const MAX_REQUESTS = 5; // max requests per window

async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  try {
    const identifier = req.ip;
    /* common identifiers for rate limiting:
    ip address : req.ip
    user id : req.user.id (if you have authentication),
    api key : req.headers['x-api-key'],
    session id : req.session.id ,
    */

    const key = `rate-limit:${identifier}`;

    const count = await redis.incr(key); // increment the count for this identifier , if the key does not exist, it will be created and set to 1

    if (count === 1) {
      await redis.expire(key, WINDOW_SECOND); // set the expiration for the key if it's the first request
    }

    const ttl = await redis.ttl(key); // get the time to live for the key

    // if the count exceeds the max requests, return a 429 Too Many Requests response
    if (count > MAX_REQUESTS) {
      return res.status(429).json({
        message: `Rate limit exceeded. Try again in ${ttl} seconds.`,
        retry_after: ttl,
      });
    }

    // request is within the rate limit, proceed to the next middleware or route handler
    next(); // proceed to the next middleware or route handler
  } catch (error) {
    console.error("Rate limiting error:", error);
    return res.status(500).json({
      message: "Rate limiting error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// apply the rate limiting middleware to a specific route
app.get("/limited", rateLimiter, (req: Request, res: Response) => {
  return res.status(200).json({
    message: "This route is rate limited",
  });
});

// #4. Queueing with BullMQ
app.post("/signup", async (req: Request, res: Response) => {
  /*
   List of task's that's need to be performed when a user signs up:
   1. create user in db
   2. send welcome email to user
   3. send notification to admin about new user signup
   4. log the signup event for analytics

   out of all these tasks, only the first one is critical and needs to be done synchronously. The rest can be done asynchronously in the background using a queue.
  */
  try {
    const { name, email, password } = req.body;

    // check if user already exists
    const existingUser = await pool.query("select id from users where email = $1", [email]);

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        message: "user already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await pool.query<Omit<IUser, "password_hash">>(
      `
      insert into users (name , email, password_hash) values
      ( $1, $2, $3) returning id, name, email, created_at, updated_at
      `,
      [name, email, passwordHash],
    );

    // typesafe check to ensure user.rows[0] is defined
    if (!user.rows[0]) {
      return res.status(500).json({
        message: "error creating user",
      });
    }

    // enqueue the background tasks for sending welcome email, notifying admin, and logging the signup event
    await emailQueue.add("sendWelcomeEmail", {
      userId: user.rows[0].id,
      email: user.rows[0].email,
    });
    // await notificationQueue.add('notifyAdmin', { userId: user.rows[0].id, name: user.rows[0].name });
    // await analyticsQueue.add('logSignupEvent', { userId: user.rows[0].id, timestamp: new Date() });

    return res.status(200).json({
      message: "user created successfully and background tasks enqueued",
      user: user.rows[0],
    });
  } catch (error) {
    return res.status(500).json({
      message: "error signing up",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});
