import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const logPath = path.join(__dirname, 'server.log')
const pidPath = path.join(__dirname, 'server.pid')
const candidateDirs = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(__dirname, '..', 'hermes-web-ui-pereview', 'node_modules'),
  path.resolve(__dirname, '..', 'node_modules')
]
const pDir = candidateDirs.find(d => fs.existsSync(d)) || ''

// Check if already running
if (fs.existsSync(pidPath)) {
  try {
    const oldPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    process.kill(oldPid, 0)
    console.log(`[Daemon] Service already running (PID: ${oldPid})`)
    process.exit(0)
  } catch {}
}

const logFd = fs.openSync(logPath, 'a')

const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    NODE_PATH: pDir
  }
})

fs.writeFileSync(pidPath, String(child.pid) + '\n')
child.unref()
console.log(`[Daemon] Started mobile watch service (PID: ${child.pid})`)
