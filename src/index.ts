import 'dotenv/config'
import { Bot, webhookCallback } from 'grammy'
import { createServer } from 'http'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import { exec } from 'child_process'
import { sync as globSync } from 'glob'
import * as yaml from 'js-yaml'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cyrillicToTranslit = require('cyrillic-to-translit-js')

/* ── Types ──────────────────────────────────────────────────── */

interface PostData {
  id: number
  title: string
  caption: string
  image: string
  tags: string[]
  url: string
  date: number
  edit_date?: number
  isMonth: boolean
  isYear: boolean
  isHighlighted: boolean
  isRemoved: boolean
  slugs?: string[]
  awards?: string[]
}

interface MainData {
  [key: string]: PostData
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TelegramPost = Record<string, any>

interface QueueJob {
  post: TelegramPost
  command: string
}

/* ── Configuration ──────────────────────────────────────────── */

const DATA_FOLDER = process.env.DATA_FOLDER ?? '_data'
const IMAGES_FOLDER = process.env.IMAGES_FOLDER ?? '_data/images'
const IMAGES_SLUG = process.env.IMAGES_SLUG ?? 'data/images/'
const CHANNEL_ID = parseInt(process.env.CHANNEL_ID ?? '0')
const ADMIN_IDS = (process.env.ADMIN_IDS ?? '')
  .split(',')
  .map(Number)
  .filter(Boolean)
const RUN_COMMAND = process.env.RUN_COMMAND ?? ''
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE ?? '20')
const mainFile = path.join(DATA_FOLDER, '_data.json')
const lastCommandFile = path.join(process.cwd(), 'lastCommand.local')

const COMMANDS = {
  REMOVE: ['delete', 'd', 'rm'],
  UPDATE: ['update', 'u', 'upd'],
  FAV: ['fav', 'f'],
  UNFAV: ['unfav', 'uf'],
  MONTH: ['month', 'm'],
  YEAR: ['year', 'y'],
}

/* ── Simple i18n ────────────────────────────────────────────── */

type LocaleTree = { [key: string]: string | LocaleTree }

function loadLocale(lang: string): LocaleTree {
  const localePath = path.join(__dirname, '..', 'locales', `${lang}.yaml`)
  return yaml.load(fs.readFileSync(localePath, 'utf-8')) as LocaleTree
}

const locales: Record<string, LocaleTree> = {
  ru: loadLocale('ru'),
}

function t(key: string, params?: Record<string, string | number>): string {
  const keys = key.split('.')
  let node: LocaleTree | string | undefined = locales['ru']
  for (const k of keys) {
    if (typeof node === 'object') {
      node = node[k]
    } else {
      return key
    }
  }
  if (typeof node !== 'string') return key
  if (params) {
    return node.replace(/\$\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
  }
  return node
}

/* ── Bot ────────────────────────────────────────────────────── */

const bot = new Bot(process.env.BOT_TOKEN ?? '')

/* ── In-memory job queue ────────────────────────────────────── */

const jobQueue: QueueJob[] = []
let isProcessing = false
let updatedPosts: number[] = []

function enqueue(job: QueueJob): void {
  jobQueue.push(job)
  if (!isProcessing) {
    void processQueue()
  }
}

async function processQueue(): Promise<void> {
  if (isProcessing) return
  isProcessing = true

  while (jobQueue.length > 0) {
    const job = jobQueue.shift()!
    try {
      const updated = await updatePost(job)
      if (updated) {
        const post = job.post
        const msgId: number = post.forward_from_message_id ?? post.message_id
        updatedPosts.push(msgId)
        if (post.from?.id && post.forward_from_message_id) {
          await bot.api.sendMessage(
            post.from.id as number,
            t('USER.MESSAGE.POST_WAS_UPDATED', {
              id: post.forward_from_message_id as number,
            }),
            { reply_to_message_id: post.message_id as number },
          )
        }
      }
    } catch (e) {
      console.error('Queue processing error:', e)
    }
  }

  isProcessing = false
  setLastCommand(COMMANDS.UPDATE[0])
  await updateFiles()
}

/* ── Command state (persisted for webhook restarts) ─────────── */

function getLastCommand(): string {
  try {
    if (fs.existsSync(lastCommandFile)) {
      return fs.readFileSync(lastCommandFile, 'utf-8').trim()
    }
  } catch {
    // ignore
  }
  return COMMANDS.UPDATE[0]
}

function setLastCommand(cmd: string): void {
  try {
    fs.writeFileSync(lastCommandFile, cmd, 'utf-8')
  } catch {
    // ignore
  }
}

/* ── Helpers ────────────────────────────────────────────────── */

function isAdmin(userId: number): boolean {
  return ADMIN_IDS.includes(userId)
}

async function downloadFile(
  fileId: string,
  baseName: string,
): Promise<string> {
  if (!fs.existsSync(IMAGES_FOLDER)) {
    fs.mkdirSync(IMAGES_FOLDER, { recursive: true })
  }
  const file = await bot.api.getFile(fileId)
  const filePath = file.file_path ?? `${baseName}.jpg`
  const downloadUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`
  const ext = path.extname(filePath)
  const fullName = `${baseName}${ext}`
  const destPath = path.join(IMAGES_FOLDER, fullName)

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destPath)
    https
      .get(downloadUrl, (res) => {
        res.pipe(out)
        out.on('finish', resolve)
        out.on('error', reject)
      })
      .on('error', reject)
  })

  return fullName
}

function prepareData(post: TelegramPost): {
  title: string
  tags: string[]
  url: string
} {
  const caption = post.caption as string | undefined
  if (!caption) return { title: '', tags: [], url: '' }

  const tags: string[] = []
  let url = ''
  let title = caption.replace(/@(.*)|♡|☆/gi, '')

  for (const entity of (post.caption_entities as Array<{
    type: string
    offset: number
    length: number
  }>) ?? []) {
    switch (entity.type) {
      case 'url':
        url = caption.slice(entity.offset, entity.length + entity.offset)
        title = title.replace(url, '')
        break
      case 'hashtag': {
        const tag = caption.slice(
          entity.offset + 1,
          entity.length + entity.offset,
        )
        tags.push(tag)
        title = title.replace(`#${tag}`, '')
        break
      }
    }
  }

  title = title.split('\n')[0].trim()
  return { url, tags, title }
}

/* ── Core logic ─────────────────────────────────────────────── */

async function updatePost({ post, command }: QueueJob): Promise<boolean> {
  if (!post.photo || (post.photo as unknown[]).length === 0) return false

  const messageId: number = post.forward_from_message_id ?? post.message_id
  const date: number = post.forward_date ?? post.date
  const editDate: number | undefined = post.forward_from_message_id
    ? (post.date as number)
    : (post.edit_date as number | undefined)

  if (!fs.existsSync(DATA_FOLDER)) {
    fs.mkdirSync(DATA_FOLDER, { recursive: true })
  }

  let mainData: MainData = {}
  if (fs.existsSync(mainFile)) {
    try {
      mainData = JSON.parse(fs.readFileSync(mainFile, 'utf-8')) as MainData
    } catch (err) {
      console.error('Failed to parse data file:', err)
    }
  }

  const photos = post.photo as Array<{ file_id: string }>
  const largestPhoto = photos[photos.length - 1]
  const fileName = await downloadFile(largestPhoto.file_id, String(messageId))
  const { title, tags, url } = prepareData(post)

  const existing = mainData[messageId]
  const isRemoved = COMMANDS.REMOVE.includes(command)
    ? true
    : existing?.isRemoved ?? false

  const isHighlighted =
    COMMANDS.FAV.includes(command) || COMMANDS.UNFAV.includes(command)
      ? COMMANDS.FAV.includes(command)
      : existing?.isHighlighted ?? false

  if (
    COMMANDS.UPDATE.includes(command) &&
    existing &&
    existing.caption === (post.caption ?? '')
  ) {
    return false
  }

  const isMonth = existing
    ? COMMANDS.MONTH.includes(command)
      ? !existing.isMonth
      : existing.isMonth
    : COMMANDS.MONTH.includes(command)

  const isYear = existing
    ? COMMANDS.YEAR.includes(command)
      ? !existing.isYear
      : existing.isYear
    : COMMANDS.YEAR.includes(command)

  mainData[messageId] = {
    id: messageId,
    title,
    caption: (post.caption as string | undefined) ?? '',
    image: fileName,
    tags,
    url,
    date,
    edit_date: editDate,
    isMonth,
    isYear,
    isHighlighted,
    isRemoved,
  }

  fs.writeFileSync(mainFile, JSON.stringify(mainData, null, 2))
  return true
}

async function updateFiles(): Promise<boolean> {
  if (!fs.existsSync(mainFile)) return false

  let mainData: MainData
  try {
    mainData = JSON.parse(fs.readFileSync(mainFile, 'utf-8')) as MainData
  } catch (err) {
    console.error('Failed to parse data file:', err)
    return false
  }

  function writePages(fileMask: string, data: PostData[]): void {
    data.sort((a, b) => b.id - a.id)
    const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE))
    for (let page = 1; page <= totalPages; page++) {
      fs.writeFileSync(
        `${fileMask}-${page}.json`,
        JSON.stringify(
          data.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
          null,
          2,
        ),
      )
    }
  }

  const tagDataUnordered: Record<string, PostData[]> = {}
  const tagSlugs: Record<string, string> = {}
  const acceptedData: PostData[] = []

  for (const id of Object.keys(mainData)) {
    const post: PostData = { ...mainData[id], slugs: [], awards: [] }
    if (post.isRemoved) continue

    for (const tagText of post.tags) {
      const tag: string = (cyrillicToTranslit() as {
        transform: (text: string, sep: string) => string
      })
        .transform(tagText, '_')
        .toLowerCase()
      post.slugs!.push(tag)
      if (!tagDataUnordered[tag]) tagDataUnordered[tag] = []
      tagDataUnordered[tag].push(post)
      tagSlugs[tag] = tagText
    }

    post.image = IMAGES_SLUG + post.image
    if (post.isMonth) post.awards!.push('month')
    if (post.isYear) post.awards!.push('year')
    acceptedData.push(post)
  }

  writePages(path.join(DATA_FOLDER, 'page'), acceptedData)

  globSync(path.join(DATA_FOLDER, 'tags-*')).forEach((f) =>
    fs.unlinkSync(f),
  )

  Object.keys(tagDataUnordered)
    .sort()
    .forEach((tag) => {
      writePages(
        path.join(DATA_FOLDER, `tags-${tag}`),
        tagDataUnordered[tag],
      )
    })

  fs.writeFileSync(
    path.join(DATA_FOLDER, 'tags.json'),
    JSON.stringify(
      Object.entries(tagSlugs).map(([slug, title]) => ({ title, slug })),
      null,
      2,
    ),
  )

  const commitMsg = t('BOT.COMMIT_MESSAGE', {
    date: new Date().toISOString(),
    updated: updatedPosts.length,
    posts: updatedPosts.join(', '),
  })
  const run = RUN_COMMAND.replace('%s', commitMsg)
  updatedPosts = []
  console.log('Running:', run)

  return new Promise<boolean>((resolve) => {
    exec(run, (err, stdout) => {
      if (!err) {
        console.log(stdout)
        resolve(true)
      } else {
        console.error(err)
        resolve(false)
      }
    })
  })
}

/* ── Bot command handlers ───────────────────────────────────── */

const allCommands = [
  ...COMMANDS.REMOVE,
  ...COMMANDS.UPDATE,
  ...COMMANDS.FAV,
  ...COMMANDS.UNFAV,
  ...COMMANDS.MONTH,
  ...COMMANDS.YEAR,
]

bot.command('start', (ctx) => ctx.reply(t('BOT.WELCOME_MESSAGE')))
bot.command('help', (ctx) => ctx.reply(t('BOT.HELP_MESSAGE')))
bot.command('myid', (ctx) => {
  const id = ctx.from?.id ?? 0
  return ctx.reply(t('USER.MESSAGE.MYID', { id }))
})

bot.command(allCommands, (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    return ctx.reply(t('USER.MESSAGE.DENY_REASON'))
  }
  const cmd = ctx.message?.text?.replace('/', '').split(' ')[0] ?? COMMANDS.UPDATE[0]
  setLastCommand(cmd)
})

bot.on('message', async (ctx) => {
  const message = ctx.message
  const forwardChat = (
    message as unknown as { forward_from_chat?: { id: number } }
  ).forward_from_chat
  if (ctx.from && isAdmin(ctx.from.id) && forwardChat?.id === CHANNEL_ID) {
    enqueue({
      post: message as unknown as TelegramPost,
      command: getLastCommand(),
    })
  } else {
    await ctx.reply(t('USER.MESSAGE.DENY_REASON'))
  }
})

bot.on('channel_post', async (ctx) => {
  const post = ctx.channelPost as unknown as TelegramPost
  if (post.chat?.id === CHANNEL_ID) {
    if (post.photo) {
      enqueue({ post, command: COMMANDS.UPDATE[0] })
    }
    if (post.text === '/getid') {
      for (const adminId of ADMIN_IDS) {
        await bot.api.sendMessage(
          adminId,
          t('CHANNEL.MESSAGE.CHANNEL_ID', { id: post.chat.id as number }),
        )
      }
      await ctx.deleteMessage()
    }
  }
})

bot.on('edited_channel_post', (ctx) => {
  const post = ctx.editedChannelPost as unknown as TelegramPost
  if (post.chat?.id === CHANNEL_ID && post.photo) {
    enqueue({ post, command: COMMANDS.UPDATE[0] })
  }
})

bot.catch((err) => {
  console.error('Bot error:', err)
})

/* ── Start ──────────────────────────────────────────────────── */

async function start(): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL
  const port = parseInt(process.env.PORT ?? '3000')

  if (webhookUrl) {
    const webhookPath = new URL(webhookUrl).pathname || '/'
    const handleUpdate = webhookCallback(bot, 'http')
    await bot.api.setWebhook(webhookUrl)
    createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === webhookPath) {
        await handleUpdate(req, res)
      } else {
        res.writeHead(200)
        res.end('OK')
      }
    }).listen(port, () => {
      console.log(
        `Webhook server running on port ${port}, path: ${webhookPath}`,
      )
    })
  } else {
    await bot.api.deleteWebhook()
    console.log('Starting with long polling…')
    await bot.start()
  }
}

start().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
