# HC Waybill: running it with Docker

You need Docker (Docker Desktop on Windows or macOS, Docker Engine on Linux) and your MariaDB server
(10.5 or newer). The app runs in one container and keeps all its data in your MariaDB database.

This folder holds:

| File | What it is |
|---|---|
| `hc-waybill-image.tar.gz` | The app (a Docker image) |
| `docker-compose.yml` | How to run it |
| `hc-waybill.env.example` | The settings to fill in |

## 1. Prepare MariaDB (once)

Create a database and a user for the app. In a MariaDB console as root (`mariadb -u root -p`), with
your own password:

```sql
CREATE DATABASE hc_waybill CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'hc_waybill'@'%' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON hc_waybill.* TO 'hc_waybill'@'%';
FLUSH PRIVILEGES;
```

The app connects from inside Docker, which is not `localhost` for MariaDB. That is why the user is
`'hc_waybill'@'%'`. **On Linux** MariaDB often listens only on 127.0.0.1. Then set
`bind-address = 0.0.0.0` in its config (e.g. `/etc/mysql/mariadb.conf.d/50-server.cnf`) and restart
MariaDB. Docker Desktop on Windows or macOS doesn't need this.

## 2. Fill in the settings (once)

Copy `hc-waybill.env.example` to `hc-waybill.env`, open it, and fill in:

- `DATABASE_URL`: put your password in place of `CHANGE_ME` (and change the user or database name if
  you used other names in step 1).
- The RS.ge service user and password, and the smsoffice.ge API key and sender name.

## 3. Load and start

In a terminal, in this folder:

```bash
docker load -i hc-waybill-image.tar.gz
docker compose up -d
```

Open **http://localhost:8080** (from other computers or phones: `http://<this computer's IP>:8080`).
On the first start the app creates its tables in the database and an admin user.

To check that it started, or to see why it didn't:

```bash
docker compose logs -f app
```

`[api] listening on http://0.0.0.0:80` means it is running. If a setting is wrong, the log says
which one. Fix `hc-waybill.env` and run `docker compose up -d` again.

## Everyday commands

| What | Command |
|---|---|
| Stop | `docker compose down` |
| Start | `docker compose up -d` |
| Logs | `docker compose logs -f app` |
| Restart after changing `hc-waybill.env` | `docker compose up -d --force-recreate` |

The app starts again by itself after a reboot, as long as Docker starts.

## Updating to a new version

You'll get a new `hc-waybill-image.tar.gz`. In this folder:

```bash
docker load -i hc-waybill-image.tar.gz
docker compose up -d --force-recreate
```

The data stays in MariaDB. Back it up as you back up your other databases (e.g. `mariadb-dump hc_waybill`).
