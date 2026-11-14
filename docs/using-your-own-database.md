# Using AskDB with your own PostgreSQL database

This guide takes you from "I have a PostgreSQL database" to asking it questions in plain English.
You will run a few commands once; after that, AskDB starts with a single command.

## How it fits together

```
 Your PostgreSQL server                      AskDB's container (on your machine)
 ┌──────────────────────────┐                ┌──────────────────────────────────┐
 │ your database (e.g. shop)│ <── read only ─│ askdb_meta: table index, history │
 │ role: askdb_readonly     │                │ (AskDB server connects to both)  │
 └──────────────────────────┘                └──────────────────────────────────┘
```

- AskDB connects to your database **only** as a restricted role, `askdb_readonly`, that you create. It can
  read the tables you allow and nothing else: no writes, no hidden columns.
- AskDB **never writes to your database**. Its own data (the table index and question history) lives in a
  separate database in AskDB's container.
- Your admin password is used once, to create the role, and is never stored by AskDB.

## What you need

| Requirement | Why |
|---|---|
| Node.js 20.6+ | Runs AskDB |
| Podman or Docker | Runs AskDB's own database |
| `psql` (PostgreSQL client) | Creates the role and runs the security check |
| An Anthropic API key | The AI that writes the SQL |
| A database user that can create roles | Only for step 3 (e.g. the database owner or admin) |
| Network access from this machine to your database | AskDB must be able to connect to it |

## Step 1: Configure AskDB

```bash
cd askdb
cp .env.example .env
```

Edit `.env` and set:

- `POSTGRES_PASSWORD`, `ASKDB_READONLY_PASSWORD`, `ASKDB_APP_PASSWORD`: any long random values (used by
  AskDB's own container)
- `ANTHROPIC_API_KEY`: your API key
- `ASKDB_CLIENT_ID_SECRET`: any random value of 16+ characters

Tip: `openssl rand -hex 16` generates a random value.

## Step 2: Start AskDB's own database

```bash
podman compose up -d          # or: docker compose up -d
```

This container holds AskDB's table index and history. It also contains the Northwind demo database,
which you can ignore.

## Step 3: Create the read-only role on your database

### 3a. Preview first (changes nothing)

Connect as a user that can create roles, and choose what AskDB must not see:

```bash
psql "host=db.example.com port=5432 dbname=shop user=admin sslmode=require" \
  -v password=x \
  -v hide_patterns='%email%,%password%,%token%,%secret%,%phone%' \
  -v dry_run=on \
  -f scripts/create-readonly-role.sql
```

It prints every table and view the role could read, and which columns would be hidden. Adjust the
options until the list looks right:

| Option | Use it for | Example |
|---|---|---|
| `hide_patterns` | Hide every column whose name matches, in every table (`%` = anything) | `'%email%,%password%'` |
| `hide_columns` | Hide specific columns that no pattern catches | `'users.notes,orders.card_last4'` |
| `hide_tables` | Hide whole tables or views | `'api_keys,customer_list'` |
| `only_tables` | Allow **only** these tables (safest for large databases) | `'orders,products,customers'` |

Watch out for:

- **Patterns that are too broad.** `%address%` also hides `address_id`, a key used to join tables, and
  AskDB could then no longer answer "customers per country". Prefer exact names (`address.street`) for
  such columns.
- **Views.** A view reads its tables with its owner's permissions, so a view that shows a hidden column
  still exposes it, possibly under another name. Hide such views with `hide_tables`.
- **Typos.** A misspelled table or column name stops the script, so nothing is silently left readable.

### 3b. Create the role

Run the same command with a real password and without `dry_run`:

```bash
RO_PASS=$(openssl rand -hex 16)

psql "host=db.example.com port=5432 dbname=shop user=admin sslmode=require" \
  -v password="$RO_PASS" \
  -v hide_patterns='%email%,%password%,%token%,%secret%,%phone%' \
  -f scripts/create-readonly-role.sql
```

It is safe to re-run at any time: the role's access is reset and granted again from the options you give.

## Step 4: Create a settings file for your database

Each database gets its own settings file, `.env.<name>`. Your API key and everything else still come from
`.env`. This writes `.env.shop` with the password from step 3b:

```bash
cat > .env.shop <<EOF
DB_HOST=db.example.com
DB_PORT=5432
DB_NAME=shop
DB_READONLY_USER=askdb_readonly
ASKDB_READONLY_PASSWORD=$RO_PASS
DB_SSL=verify
META_DB_HOST=127.0.0.1
META_DB_PORT=5433
EOF
chmod 600 .env.shop
```

| Setting | Meaning |
|---|---|
| `DB_SSL` | `verify` for remote databases (encrypted, certificate checked), `disable` for a database on this machine, `require` if `verify` is impossible (encrypted, not checked) |
| `META_DB_HOST` / `META_DB_PORT` | Keep these: they point AskDB at its own database in the container from step 2 |

Settings files (`.env`, `.env.*`) are never committed to Git.

## Step 5: Prove the role is locked down

```bash
./scripts/verify-db-security.sh --db shop
```

It logs in as `askdb_readonly` and tries real attacks: writing, deleting, dropping tables, reading server
files, reading password hashes and reading every hidden column. Every write attempt is rolled back, so it
is safe on real data.

- **You need 0 failures.**
- **Review the "sensitive-looking names" warning**: readable columns named like email, phone, address or
  token. If one holds personal data, add it to the options and repeat step 3b.
- On managed services (AWS RDS, Neon, ...) two warnings for `pg_sleep`/`set_config` are expected; AskDB's
  SQL guard blocks those functions instead.

## Step 6: Build the table index

```bash
cd server
npm install
npm run index-schema -- --db shop
```

AskDB reads your table structure (as the restricted role, so hidden columns never appear), asks the AI
for a short description of each table, and stores it in its own database. The output ends with
`Database: db.example.com:5432/shop`. Re-running it later only re-describes tables that changed.

## Step 7: Start AskDB and ask questions

```bash
npm run dev -- --db shop                        # terminal 1, in server/
cd ../client && npm install && npm run dev      # terminal 2: open http://127.0.0.1:5173
```

The first log line shows which database is in use: `askdb_api_starting db=db.example.com:5432/shop`.

Or ask from the terminal:

```bash
npm run ask -- --db shop "How many orders were placed last month?"
```

The `--` before `--db` is required with `npm run`.

## Day-to-day use

| Task | Command (in `server/`) |
|---|---|
| Start AskDB on your database | `npm run dev -- --db shop` |
| Start the bundled Northwind demo instead | `npm run dev` |
| Re-check security | `../scripts/verify-db-security.sh --db shop` |
| After adding tables or columns, or changing what is hidden | Re-run step 3b, then step 5, then `npm run index-schema -- --db shop`, then restart AskDB |

- New tables stay unreadable to AskDB until you re-run step 3b.
- Each database has its own table index and its own history, so switching with `--db` is instant and
  "Ask again" always goes to the right database.
- Run one AskDB server at a time (they share port 3001).

## Built-in safety at startup

Before answering anything, AskDB checks its setup and refuses to start, with a message saying what to fix:

| Situation | What AskDB says |
|---|---|
| The role can write, is an administrator, or can bypass hidden columns | `Refusing to start: the database role is not read-only.` and the reason |
| Wrong password or user | `wrong password, or no such user. Check ASKDB_READONLY_PASSWORD and the user name in .env.shop` |
| Database server not running or unreachable | `nothing is accepting connections at that address` |
| Wrong database name | `database "x" does not exist` |
| AskDB's own container not running | `Cannot connect to AskDB's own database ... Is the bundled container running?` |
| TLS / certificate problem | `TLS problem ... Check DB_SSL` |

If a message mentions `.env` while you meant to use your database, you forgot `--db shop`, or the terminal
still has old settings exported: open a new terminal.

## Cloud databases (e.g. AWS RDS)

The steps are the same; these points differ. They are based on how RDS works and have not been tested
against a live RDS instance.

1. **Network access.** RDS usually sits in a private network. Run AskDB inside the same VPC, or reach it
   from your machine through an AWS Systems Manager port forward:
   ```bash
   aws ssm start-session --target i-0abc123 \
     --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters host=shop.abc123.eu-west-1.rds.amazonaws.com,portNumber=5432,localPortNumber=5435
   ```
   Then use `DB_HOST=127.0.0.1`, `DB_PORT=5435` and `DB_SSL=require` (the certificate names the RDS host,
   not 127.0.0.1, so `verify` fails through a tunnel; the tunnel itself is encrypted).
2. **Admin password from Secrets Manager**, for step 3 only (never saved):
   ```bash
   export PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id 'rds!db-1234abcd' \
     --query SecretString --output text | jq -r .password)
   ```
3. **The RDS master user is not a full superuser.** It can create the role but can only grant tables it
   owns (or whose owner role it belongs to); if the tables belong to an application user, run step 3 as
   that user. `harden_functions=on` is refused by RDS; the script prints a warning and continues.
4. **Trust Amazon's certificate** for `DB_SSL=verify`:
   ```bash
   curl -o ~/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   export NODE_EXTRA_CA_CERTS=$HOME/rds-global-bundle.pem      # before npm run ...
   PGSSLMODE=verify-full PGSSLROOTCERT=$HOME/rds-global-bundle.pem ../scripts/verify-db-security.sh --db shop
   ```
5. **Keep AskDB's password out of files (optional).** Store it in Secrets Manager, leave
   `ASKDB_READONLY_PASSWORD` out of `.env.shop`, and provide it when starting:
   ```bash
   export ASKDB_READONLY_PASSWORD=$(aws secretsmanager get-secret-value \
     --secret-id askdb/shop-readonly --query SecretString --output text)
   npm run dev -- --db shop
   ```
6. **Use a read replica** if you have one, so heavy questions never slow down the main database.

## Removing AskDB from your database

On your database, as the admin user:

```sql
DROP OWNED BY askdb_readonly;   -- removes its privileges
DROP ROLE askdb_readonly;
```

Then delete `.env.shop`. To also remove AskDB's index and history for that database:

```bash
psql "host=127.0.0.1 port=5433 dbname=askdb_meta user=askdb_app" \
  -c "DELETE FROM schema_docs WHERE source = 'db.example.com:5432/shop'" \
  -c "DELETE FROM audit_log WHERE source = 'db.example.com:5432/shop'"
```

(The password is `ASKDB_APP_PASSWORD` from `.env`.)

## Limitations

- One database per running AskDB server; switch with `--db`.
- Only the `public` schema is read.
- Restart AskDB after changing the role's permissions.
- Setup is done from the command line; there is no in-app "connect a database" screen.
