/**
 * Live test of the QQ bridge: poll the open chat for 30 seconds and print whatever
 * the bridge would deliver to the assistant.
 */
import { startQqBridge, qqStatus, sendQq } from '../qq-bridge.js'

console.log('starting bridge; send a QQ message now')
startQqBridge({
  deliver: async text => {
    console.log('DELIVER ->', JSON.stringify(text))
  },
})

const timer = setInterval(() => {
  const status = qqStatus()
  console.log('status:', JSON.stringify(status))
}, 5000)

setTimeout(async () => {
  clearInterval(timer)
  console.log('final status:', JSON.stringify(qqStatus()))
  console.log('send test:', JSON.stringify(await sendQq('dsh 桥接测试：收到请忽略')))
  process.exit(0)
}, 30_000)
