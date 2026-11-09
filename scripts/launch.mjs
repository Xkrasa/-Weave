#!/usr/bin/env node
/**
 * 一键启动器：双击 `start-weave.cmd` 或运行 `node scripts/launch.mjs`。
 *
 * 它只做四件事，然后交给现有 CLI：
 * 1. 第一次运行自动建一本书（books/main）；
 * 2. 从仓库根的 .env 里挑一个可用的密钥变量名，绑定到项目配置；
 * 3. 启动本地工作台并打开浏览器；
 * 4. 不修改任何正文、Canon 或账本。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const ENV_FILE = path.join(REPO_ROOT, '.env')
const BOOK_DIR = path.join(REPO_ROOT, 'books', 'main')
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts')
const CONFIG = path.join(BOOK_DIR, '.weave', 'config.json')
const PORT = '8799'

const args = process.argv.slice(2)
const noOpen = args.includes('--no-open')
const portArg = args.find(arg => arg.startsWith('--port='))
const port = portArg ? portArg.slice('--port='.length) : PORT

/** Reads variable names only; values never leave process.env. */
function envNames() {
  if (!existsSync(ENV_FILE)) return []
  return readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split('=')[0].trim())
}

function fail(message) {
  console.error(`\n启动失败：${message}\n`)
  process.exit(1)
}

function runCli(cliArgs, inherit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...cliArgs], {
      cwd: REPO_ROOT,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    if (!inherit) {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', chunk => { output += chunk })
      child.stderr?.on('data', chunk => { output += chunk })
    }
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(output)
      else reject(new Error(output.trim() || `退出码 ${code}`))
    })
  })
}

const names = envNames()
const keyVar = ['WEAVE_API_KEY', 'Mimo_API_KEY', 'Google_API_KEY'].find(name => names.includes(name))

if (!keyVar) {
  fail(
    '没有找到可用的密钥。请在本目录新建 `.env`，写入下面任意一行：\n'
    + '  Mimo_API_KEY=你的key      （小米 MiMo）\n'
    + '  Google_API_KEY=你的key    （Google Gemini）\n'
    + '  WEAVE_API_KEY=你的key     （其他 OpenAI 兼容服务）',
  )
}

const model = keyVar === 'Mimo_API_KEY'
  ? { name: 'mimo-v2.6-pro', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' }
  : keyVar === 'Google_API_KEY'
    ? { name: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }
    : { name: 'glm-5.3', baseUrl: 'http://127.0.0.1:7863/v1' }

async function main() {
  if (!existsSync(CONFIG)) {
    console.log('首次启动：正在创建书稿项目（books/main）…')
    await runCli([
      'init', BOOK_DIR,
      '--title', '我的新书',
      '--model', model.name,
      '--base-url', model.baseUrl,
      '--workflow', 'p05',
      '--platform', 'fanqie',
    ], true)
  }

  // 每次启动都对一次密钥变量名，方便换 key 或换服务商。
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
  if (config.apiKeyEnv !== keyVar) {
    config.apiKeyEnv = keyVar
    writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`)
  }
  if (config.model !== model.name) {
    config.model = model.name
    config.baseUrl = model.baseUrl
    writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`)
  }

  const uiArgs = [
    '--env-file', ENV_FILE,
    '--root', BOOK_DIR,
    'ui',
    '--port', port,
    '--library-root', path.join(REPO_ROOT, 'books'),
  ]
  if (!noOpen) uiArgs.push('--open')
  console.log(`\n正在打开工作台：${model.name} · ${path.relative(REPO_ROOT, BOOK_DIR)}`)
  await runCli(uiArgs, true)
}

main().catch(error => fail(error.message))
