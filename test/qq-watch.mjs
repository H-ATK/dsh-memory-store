/**
 * Watch the QQ bridge for 90 seconds, reporting every poll result.
 * The user closes the QQ window and sends a message from the phone; this proves
 * whether restore-then-read picks it up.
 */
import { startQqBridge, qqStatus } from '../qq-bridge.js'

let deliveries = 0
startQqBridge({
  uin: '10000000',
  deliver: async text => {
    deliveries += 1
    console.log(`[${new Date().toLocaleTimeString()}] DELIVER #${deliveries}:`, JSON.stringify(text))
  },
})

let ticks = 0
const timer = setInterval(() => {
  ticks += 1
  const status = qqStatus()
  console.log(`[${new Date().toLocaleTimeString()}] poll ${ticks}: online=${status.online} lastError=${JSON.stringify(status.lastError)}`)
}, 3000)

setTimeout(() => {
  clearInterval(timer)
  console.log('done. deliveries:', deliveries, 'final:', JSON.stringify(qqStatus()))
  process.exit(0)
}, 90_000)
