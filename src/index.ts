import bcrypt from "bcrypt";
import express from "express";
import type { Request, Response } from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import type { IUser } from "./types.js";
import { ALL } from "node:dns";

const port = config.port || 3000;
const app = express();
app.use(express.json());

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

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});
