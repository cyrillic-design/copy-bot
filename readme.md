[![Codacy Badge](https://api.codacy.com/project/badge/Grade/e69578f347274eaaaa858f385dfed285)](https://app.codacy.com/gh/cyrillic-design/copy-bot?utm_source=github.com&utm_medium=referral&utm_content=cyrillic-design/copy-bot&utm_campaign=Badge_Grade_Dashboard)

# Copy bot

A Telegram bot (TypeScript + [grammY](https://grammy.dev)) that listens to a
Telegram channel and publishes its photo posts as paginated JSON data files for
any static site hosted on **GitHub Pages** (or anywhere else).

---

## How it works

1. Forward a post from your channel to the bot (or add the bot to the channel
   as an admin and let it pick up new posts automatically).
2. The bot downloads the photo, parses the caption for title / hashtags / URL,
   and writes structured JSON files to `DATA_FOLDER`.
3. After all queued posts are processed, `RUN_COMMAND` is executed — typically
   a `git commit && git push` that publishes the data to your GitHub Pages
   repository.

The bot works with **any** GitHub Pages (or similar) setup: configure
`DATA_FOLDER`, `IMAGES_FOLDER`, `IMAGES_SLUG`, and `RUN_COMMAND` to match your
project.

---

## Setup

### 1. Clone & install

```sh
git clone https://github.com/cyrillic-design/copy-bot.git
cd copy-bot
npm install
```

### 2. Configure

Copy `.env_sample` to `.env.local` and fill in your values:

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/botfather) |
| `CHANNEL_ID` | Numeric ID of the source channel (e.g. `-1001234567890`) |
| `ADMIN_IDS` | Comma-separated Telegram user IDs of admins |
| `DATA_FOLDER` | Path where JSON files will be written |
| `IMAGES_FOLDER` | Path where downloaded images will be stored |
| `IMAGES_SLUG` | URL prefix for images in generated JSON |
| `RUN_COMMAND` | Command to run after update (e.g. `cd _web && git push`) |
| `PAGE_SIZE` | Posts per JSON page (default `20`) |
| `WEBHOOK_URL` | Full URL for Telegram webhook — **omit for long polling** |
| `PORT` | HTTP port (default `3000`) |

### 3. Run

**Development** (long polling, no webhook needed):

```sh
npm run dev
```

**Production** (after `npm run build`):

```sh
npm start
```

---

## Heroku

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

Set the following config vars in Heroku (or via the deploy button form):

- `BOT_TOKEN` – Telegram bot token
- `CHANNEL_ID` – Source channel ID
- `ADMIN_IDS` – Admin user IDs
- `WEBHOOK_URL` – Your Heroku app URL (e.g. `https://my-bot.herokuapp.com/`)
- `RUN_COMMAND` – The deploy command for your GitHub Pages repo

Heroku sets `PORT` automatically; no manual configuration needed.

To enable automatic commits you may also install an SSH buildpack:
<https://github.com/simon0191/custom-ssh-key-buildpack>

---

## Docker

```sh
docker-compose up --build
```

---

## Lint

```sh
npm run lint
```

Enable pre-commit linting:

```sh
git config core.hooksPath .githooks
```

---

## Bot commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/help` | Help message |
| `/myid` | Show your Telegram user ID |
| `/update` (or `/u`, `/upd`) | Set mode: update post |
| `/delete` (or `/d`, `/rm`) | Set mode: mark post as removed |
| `/fav` (or `/f`) | Set mode: mark as favourite |
| `/unfav` (or `/uf`) | Set mode: remove favourite |
| `/month` (or `/m`) | Toggle "post of the month" |
| `/year` (or `/y`) | Toggle "post of the year" |

---

&copy; 2020–2024, [@jfkz](https://github.com/jfkz)
