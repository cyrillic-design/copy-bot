require('dotenv-load')()
require('colors')

const Telegraf = require('telegraf/telegraf')
const TelegrafI18n = require('telegraf-i18n')
const session = require('telegraf/session')
// const updateLogger = require('telegraf-update-logger')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const Queue = require('bull')
const cyrillicToTranslit = require('cyrillic-to-translit-js')
const glob = require('glob')

/* Setup constants */
const mainFile = process.env.DATA_FOLDER + '/_data.json'
const COMMANDS = {
  REMOVE: ['delete', 'd', 'rm'],
  UPDATE: ['update', 'u', 'upd'],
  FAV: ['fav', 'f'],
  UNFAV: ['unfav', 'uf'],
  MONTH: ['month', 'm'],
  YEAR: ['year', 'y']
}
const lastCommandFile = './lastCommand.local'
let updatedPosts = []
let lastCommand = COMMANDS.UPDATE[0]
let webhookEnabled = false

/* Config queue */
const redisHost = process.env.REDIS_HOST || '127.0.0.1'
const postsQue = new Queue('posts queue', { redis: { port: 6379, host: redisHost } })
postsQue.process(function (job) {
  return updatePost(job.data)
})
postsQue.on('completed', function (job, result) {
  if (job.data.post) {
    const post = job.data.post
    if (post.from && post.from.id && post.forward_from_message_id) {
      updatedPosts.push(job.data.post.forward_from_message_id)
      bot.telegram.sendMessage(
        post.from.id,
        i18n.t(i18n.config.defaultLanguage, 'USER.MESSAGE.POST_WAS_UPDATED', {
          id: post.forward_from_message_id
        }), {
          reply_to_message_id: post.message_id
        }
      )
    } else {
      updatedPosts.push(job.data.post.message_id)
    }
  }
})
postsQue.on('global:drained', function () {
  setLastCommand(COMMANDS.UPDATE[0])
  return updateFiles()
})

/* Config bot */
const bot = new Telegraf(process.env.BOT_TOKEN)
const i18n = new TelegrafI18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
  allowMissing: true, // Default true
  useSession: true
})

// if (process.env.NODE_ENV !== 'production') {
//   bot.use(updateLogger({ colors: true }))
// }
bot.use(session())
bot.use(i18n.middleware())

/* Setup webhook */
try { // Use try to hide parser error
  const webhookHost = new URL(process.env.WEBHOOK_URL)
  if (webhookHost.hostname) {
    require('http')
      .createServer(bot.webhookCallback(webhookHost.pathname))
      .listen(process.env.PORT)
    webhookEnabled = true
  }
} catch (e) {}

/* Commands */
bot.start(({ reply, i18n }) => reply(i18n.t('BOT.WELCOME_MESSAGE')))
bot.help(({ reply, i18n }) => reply(i18n.t('BOT.HELP_MESSAGE')))
bot.command('myid', ({ from, reply, i18n }) => {
  reply(i18n.t('USER.MESSAGE.MYID', { id: from.id }))
})
bot.command(
  [...COMMANDS.REMOVE, ...COMMANDS.UPDATE, ...COMMANDS.FAV, ...COMMANDS.UNFAV, ...COMMANDS.MONTH, ...COMMANDS.YEAR],
  ctx => {
    if (!isAdmin(ctx.from.id)) { return ctx.reply(ctx.i18n.t('USER.MESSAGE.DENY_REASON')) }
    setLastCommand(ctx.message.text.replace('/', ''))
  }
)

bot.on('message', async ctx => {
  const message = ctx.message
  if (
    isAdmin(ctx.from.id) &&
    message.forward_from_chat &&
    message.forward_from_chat.id &&
    message.forward_from_chat.id === parseInt(process.env.CHANNEL_ID)
  ) {
    // lastCommand = lastCommand || COMMANDS.UPDATE[0]
    postsQue.add({
      post: message,
      command: getLastCommand()
    })
  } else {
    ctx.reply(ctx.i18n.t('USER.MESSAGE.DENY_REASON'))
  }
})

bot.use(
  async ({
    channelPost,
    editedChannelPost,
    reply,
    telegram,
    deleteMessage,
    i18n
  }) => {
    const post = channelPost || editedChannelPost
    if (post) {
      if (post.chat.id === parseInt(process.env.CHANNEL_ID)) {
        if (post.photo) {
          // If we editing post in channel - its always have to be UPDATE
          postsQue.add({ post: post, command: COMMANDS.UPDATE[0] })
        }
      }
      if (post.text === '/getid') {
        const admins = process.env.ADMIN_IDS.split(',')
        for (var id in admins) {
          telegram.sendMessage(
            admins[id],
            i18n.t('CHANNEL.MESSAGE.CHANNEL_ID', { id: post.chat.id })
          )
        }
        deleteMessage(post.message_id)
      }
    }
  }
)

/* Support functions */
function isAdmin (from_id) {
  const admins = process.env.ADMIN_IDS.split(',')
  for (var id in admins) {
    if (parseInt(admins[id]) === from_id) {
      return true
    }
  }
  return false
}

function getLastCommand () {
  if (webhookEnabled) {
    if (fs.existsSync(mainFile)) {
      return fs.readFileSync(lastCommandFile)
    } else {
      return COMMANDS.UPDATE[0]
    }
  } else {
    return lastCommand
  }
}

function setLastCommand (cmd) {
  if (webhookEnabled) {
    fs.writeFileSync(lastCommandFile, cmd)
  } else {
    lastCommand = cmd
  }
}

/* Producer functions */
async function updateFiles () {
  function writeFiles (file_mask, data) {
    data.sort((a, b) => b.id - a.id)
    const file_size = process.env.PAGE_SIZE
    if (data.length < file_size) {
      const jsonData = JSON.stringify(data, null, 2)
      fs.writeFileSync(`${file_mask}-1.json`, jsonData)
    } else {
      let page = 1
      while (page <= Math.ceil(data.length / file_size)) {
        fs.writeFileSync(
          `${file_mask}-${page}.json`,
          JSON.stringify(
            data.slice((page - 1) * file_size, page * file_size),
            null,
            2
          )
        )
        page++
      }
    }
  }

  let result = false
  if (fs.existsSync(mainFile)) {
    let mainData = {}
    try {
      const rawdata = fs.readFileSync(mainFile)
      mainData = JSON.parse(rawdata)
    } catch (err) {
      console.log(err.toString().red)
    }
    const tagDataUnordered = {}
    const tagSlugs = []
    const acceptedData = []
    for (const id in mainData) {
      const post = mainData[id]
      if (post.isRemoved) {
        continue
      }
      post.slugs = []
      for (const tag_id in post.tags) {
        const tagText = post.tags[tag_id]
        const tag = cyrillicToTranslit()
          .transform(tagText, '_')
          .toLowerCase()
        post.slugs.push(tag)
        if (!tagDataUnordered[tag]) {
          tagDataUnordered[tag] = []
        }
        tagDataUnordered[tag].push(post)
        tagSlugs[tag] = tagText
      }
      post.image = process.env.IMAGES_SLUG + post.image
      post.awards = []
      if (post.isMonth) { post.awards.push('month') }
      if (post.isYear) { post.awards.push('year') }
      acceptedData.push(post)
    }

    // Pages
    writeFiles(process.env.DATA_FOLDER + '/page', Object.values(acceptedData))
    // Tags: sort
    glob
      .sync(process.env.DATA_FOLDER + '/tags-*')
      .forEach(fs.unlinkSync)
    const tagData = {}
    Object.keys(tagDataUnordered)
      .sort()
      .forEach(function (key) {
        tagData[key] = tagDataUnordered[key]
        writeFiles(
          process.env.DATA_FOLDER + `/tags-${key}`,
          tagDataUnordered[key]
        )
      })
    // Tags: make main file
    const tagsForFile = []
    for (const slug in tagSlugs) {
      tagsForFile.push({ title: tagSlugs[slug], slug: slug })
    }
    fs.writeFileSync(
      process.env.DATA_FOLDER + '/tags.json',
      JSON.stringify(tagsForFile, null, 2)
    )

    const run = process.env.RUN_COMMAND.replace(
      '%s',
      i18n.t(i18n.config.defaultLanguage, 'BOT.COMMIT_MESSAGE', {
        date: new Date().toString().toLowerCase(),
        updated: updatedPosts.length,
        posts: updatedPosts.join(', ')
      })
    )
    console.log(run)
    updatedPosts = []
    result = await new Promise((resolve) => exec(run, (err, stdout, stderr) => {
      if (!err) {
        console.log(stdout)
        resolve(true)
      } else {
        console.log(err)
        resolve(false)
      }
    }))
  }
  return result
}

async function updatePost ({ post, command }) {
  async function downloadFile ({ file_id, file_name }) {
    if (!fs.existsSync(process.env.IMAGES_FOLDER)) {
      fs.mkdirSync(process.env.IMAGES_FOLDER)
    }
    const link = await bot.telegram.getFileLink(file_id)
    const ext = path.extname(link)
    file_name = file_name + ext
    const file = fs.createWriteStream(
      process.env.IMAGES_FOLDER + '/' + file_name
    )
    https.get(link, function (response) {
      response.pipe(file)
    })
    return file_name
  }

  function prepareData (post) {
    const caption = post.caption
    if (!caption) {
      return { title: '', tags: '', url: '' }
    }
    const tags = []
    let url = ''
    let title = caption.replace(/@(.*)|♡|☆/gi, '')
    for (var id in post.caption_entities) {
      const entity = post.caption_entities[id]
      let tag = ''
      switch (entity.type) {
        case 'url':
          url = caption.slice(entity.offset, entity.length + entity.offset)
          title = title.replace(url, '')
          break
        case 'hashtag':
          tag = caption.slice(
            entity.offset + 1,
            entity.length + entity.offset
          )
          tags.push(tag)
          title = title.replace(`#${tag}`, '')
          break
      }
    }
    title = title.split('\n')[0]
    return {
      url: url,
      tags: tags,
      title: title.trim()
    }
  }

  const message_id = post.forward_from_message_id || post.message_id
  const date = post.forward_date || post.date
  const edit_date = post.forward_from_message_id ? post.date : post.edit_date
  if (!post || !post.photo) {
    return false
  }
  let mainData = {}
  if (!fs.existsSync(process.env.DATA_FOLDER)) {
    fs.mkdirSync(process.env.DATA_FOLDER)
  }
  if (fs.existsSync(mainFile)) {
    const rawdata = fs.readFileSync(mainFile)
    mainData = JSON.parse(rawdata)
  }
  const file_name = await downloadFile({
    file_id: post.photo.pop().file_id,
    file_name: message_id
  })
  const { title, tags, url } = prepareData(post)
  const isRemoved =
    COMMANDS.REMOVE.indexOf(command) >= 0
      ? true
      : (mainData[message_id] && mainData[message_id].isRemoved) || false
  const isHighlighted =
    COMMANDS.FAV.indexOf(command) >= 0 || COMMANDS.UNFAV.indexOf(command) >= 0
      ? COMMANDS.FAV.indexOf(command) >= 0
      : (mainData[message_id] && mainData[message_id].isHighlighted) || false
  if (COMMANDS.UPDATE.indexOf(command) >= 0 && mainData[message_id] && mainData[message_id].caption === post.caption) {
    return false
  }
  const isMonth =
    mainData[message_id]
      ? (COMMANDS.MONTH.indexOf(command) >= 0 ? !mainData[message_id].isMonth : mainData[message_id].isMonth)
      : COMMANDS.MONTH.indexOf(command) >= 0
  const isYear =
    mainData[message_id]
      ? (COMMANDS.YEAR.indexOf(command) >= 0 ? !mainData[message_id].isYear : mainData[message_id].isYear)
      : COMMANDS.YEAR.indexOf(command) >= 0
  mainData[message_id] = {
    id: message_id,
    title: title,
    caption: post.caption || '',
    image: file_name,
    tags: tags,
    url: url,
    date: date,
    edit_date: edit_date,
    isMonth: isMonth,
    isYear: isYear,
    isHighlighted: isHighlighted,
    isRemoved: isRemoved
  }
  const data = JSON.stringify(mainData, null, 2)
  return fs.writeFileSync(mainFile, data)
}

bot.handleError = (err) => {
  const text = (err.stack || err.toString()).replace(/^/gm, '  ')
  console.log(text.red)
}

bot.launch()
