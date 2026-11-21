# Publishing HC Portal on Vercel

One Vercel project holds everything. The web app and the API run as one Docker container
(`Dockerfile.vercel`), and the data goes to a Neon PostgreSQL database that Vercel creates for you.

## 1. Create the project

1. Go to [vercel.com/new](https://vercel.com/new) and import this GitHub repository.
2. The framework preset should say **Container** (`Dockerfile.vercel` selects it). If it says Vite,
   pick *Container* (CLI: `vercel project update --framework container --yes`).
3. Open **Environment Variables** and add the same values as your local `.env`:

   | Name | Value |
   |---|---|
   | `RS_SERVICE_USER` | `name:taxcode` |
   | `RS_SERVICE_PASSWORD` | the password |
   | `SMSOFFICE_API_KEY` | the smsoffice.ge key |
   | `SMSOFFICE_SENDER` | the sender name |
   | `CRON_SECRET` | any random string of 16+ characters |
   | `WAYBILL_AUTO_CLOSE` | optional, e.g. `8:00` |

4. Click **Deploy**. This first deployment fails to start because it has no database yet. Step 2 fixes that.

## 2. Add the database

1. In the project, open **Storage** → **Create Database** → **Neon** (Postgres) → *Continue*. The free
   plan is enough. Connect it to the project for all environments.
2. This adds `DATABASE_URL` to the project's variables.
3. Open **Deployments**, click **⋯** next to the latest deployment, then **Redeploy**.

The site is now live at `https://<project>.vercel.app`. It starts with only the admin user from the seed.

## 3. Bring your current data (optional)

To move your local data (users, carriers, routes, drivers, trucks, shipments, logs) into the new
database, run this once on your computer:

1. Copy `DATABASE_URL` from **Storage** → your database → **.env.local** tab (*Show secret*).
2. Run:

   ```bash
   DATABASE_URL='postgres://…' npm run db:import
   ```

   This copies `server/data/hc.db` into the database. Stop `npm run dev` first, or copy the file with
   `sqlite3 server/data/hc.db ".backup copy.db"` and pass `copy.db` as an argument. If the database
   already has data, the command stops; run it again with `-- --replace` to overwrite that data.
3. Redeploy again (as in step 2.3) so the server loads the copied data.

## 4. Android app

Point the APK at the new address and build it again:

```bash
VITE_API_URL=https://<project>.vercel.app npm run android:apk
```

## Good to know

- **Updates:** every `git push` to `main` deploys again. The data stays in the database.
- **Idle server:** Vercel stops the server after about 5 minutes with no use. The next visit wakes it,
  and that first page takes a few seconds longer because the server checks RS.ge and SMS first.
- **Background work:** while the app is in use, the server completes due waybills and checks SMS delivery
  every minute, as it does locally. When it wakes, it catches up on anything it missed while it was
  stopped. Vercel Cron also calls `/api/cron` once a day. The free Hobby plan allows only daily cron
  jobs. On Pro you can change the schedule in `vercel.json` to `*/5 * * * *`.
- **RS.ge IP restriction:** Vercel has no fixed outgoing IP for containers. If the RS.ge service user
  is limited to one IP address, remove that limit on eservices.rs.ge.
- **Several server copies:** under load Vercel may run more than one copy. They share the
  database. Each copy loads changes made by the others before it answers a request, and a shipment
  is worked on by one copy at a time.

## Without Vercel: any machine with Docker

```bash
cp .env.example .env    # fill in the accounts
docker compose up --build -d
```

The app is then at `http://localhost:8080`, with its own PostgreSQL. To bring your data:

```bash
docker compose cp server/data/hc.db app:/tmp/hc.db
docker compose exec app node scripts/db-import.ts /tmp/hc.db
docker compose restart app
```
