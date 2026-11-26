# HC Waybill — გაშვება

საჭიროა: **Docker** და **MariaDB**.

## 1. ბაზის შექმნა

MariaDB-ში (`mariadb -u root -p`):

```sql
CREATE DATABASE hc_waybill CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'hc_waybill'@'%' IDENTIFIED BY 'თქვენი-პაროლი';
GRANT ALL PRIVILEGES ON hc_waybill.* TO 'hc_waybill'@'%';
```

## 2. `.env` ფაილის შევსება

დააკოპირეთ `.env.example` → `.env` (იმავე საქაღალდეში) და შეავსეთ:

```
DATABASE_URL=mysql://hc_waybill:თქვენი-პაროლი@host.docker.internal:3306/hc_waybill
RS_SERVICE_USER=სახელი:საიდენტიფიკაციო_კოდი
RS_SERVICE_PASSWORD=RS.ge-ის პაროლი
SMSOFFICE_API_KEY=smsoffice.ge-ის გასაღები
SMSOFFICE_SENDER=გამგზავნის სახელი
```

## 3. გაშვება

```bash
docker load -i hc-waybill-image.tar.gz
docker compose up -d
```

გახსენით: **http://localhost:8080**

თუ არ ჩაირთო, შეცდომას აქ ნახავთ: `docker compose logs app`
