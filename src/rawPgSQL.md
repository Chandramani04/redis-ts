# Using PostgreSQL with raw SQL

This project uses PostgreSQL for durable relational data, the `pg` package to connect from Node.js, and SQL statements written by the application developer. “Raw PostgreSQL” here means writing SQL directly and sending it through `pg`; it does not mean bypassing a client library.

## 1. Start PostgreSQL

The repository already defines a Postgres service in the root `docker-compose.yaml`. From the repository root, start it with:

```bash
docker compose up -d postgres
```

Compose names the container `myapp-postgres`. The configured local connection URL is:

```dotenv
DATABASE_URL=postgresql://app:app@localhost:5432/test
```

Put that in the root `.env` file. Do not commit `.env`; use a secret manager or deployment environment variables outside local development. The project’s `src/config.ts` reads `DATABASE_URL`, and `src/db.ts` creates the `pg` connection pool from it.

## 2. Create the table with SQL

Create `migrations/001_create_users.sql` (or use `sql/schema.sql` for a disposable prototype) with:

```sql
CREATE TABLE users (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  password   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

The `password` column must contain a password hash, never a plaintext password. `timestamptz` stores instants with time-zone awareness. `updated_at` gets its default on insert; Postgres will not automatically change it on later updates unless the update statement sets it (or you add a trigger).

Run a one-off schema file from the repository root with `psql` installed:

```bash
psql "$DATABASE_URL" -f migrations/001_create_users.sql
```

Alternatively, copy a SQL file into the running container and execute it there:

```bash
docker compose exec -T postgres psql -U app -d test < db/schema.sql
```

The `docker exec ... -f` form expects the SQL file to exist inside the container. A shell input redirect such as `docker exec ... < file.sql` feeds input to the local Docker process and is not a reliable way to send the file to `psql` inside the container.

## 3. Keep the TypeScript type aligned

The project’s `src/types.ts` currently exports `IUser`. Its fields should match the columns returned by queries. With `pg`, timestamps are normally parsed as JavaScript `Date` values, while `integer` is returned as `number`:

```ts
export interface IUser {
  id: number;
  name: string;
  email: string;
  password: string; // a password hash, never plaintext
  created_at: Date;
  updated_at: Date;
}
```

This interface is compile-time help only. It does not validate runtime data or create a table. The SQL migration creates and constrains the actual database schema.

## 4. Query through the existing pool

The repository already exports `pool` from `src/db.ts`, so there is no need to create another pool or install `pg` again. For a single query, `pool.query` is simpler than manually checking out a client:

```ts
import { pool } from "./db.js";
import type { IUser } from "./types.js";

export async function createUser(
  user: Pick<IUser, "name" | "email" | "password">,
): Promise<IUser> {
  const result = await pool.query<IUser>(
    `INSERT INTO users (name, email, password)
     VALUES ($1, $2, $3)
     RETURNING id, name, email, password, created_at, updated_at`,
    [user.name, user.email, user.password],
  );

  return result.rows[0];
}

export async function getUsers(): Promise<IUser[]> {
  const result = await pool.query<IUser>(
    `SELECT id, name, email, password, created_at, updated_at
     FROM users
     ORDER BY id`,
  );

  return result.rows;
}
```

Use `$1`, `$2`, etc. for values; do not build SQL by interpolating user input. `pg`'s generic type parameter gives TypeScript a result type, but does not perform runtime validation. Avoid selecting or returning password hashes from API endpoints; select only fields the caller is allowed to see.

Use `pool.connect()` when a group of statements must share one connection, such as a transaction. Always release a checked-out client in a `finally` block.

## 5. Track schema changes

For a quick local experiment, a single `schema.sql` is fine if you can reset the database. As the project grows, use ordered, append-only migration files such as `migrations/001_create_users.sql` and `migrations/002_add_user_display_name.sql`. Apply each migration once and record its name in a migration-history table, either with a migration runner or a small script. Do not edit a migration that has already run; create a new migration for each schema change.

Raw SQL migrations and raw SQL queries are separate choices: you can keep SQL migrations while later adopting a query builder or ORM for application queries.
