/**
 * Text cleanup for outgoing replies.
 *
 * Speech synthesis and the on-screen voice conversation are gone. What survives is the
 * cleaner: a reply is still shortened for speech-shaped output before it goes back over
 * QQ, so code fences and markup never leak into the chat.
 */

/**
 * Strip what should not be read out loud: code fences, markup, links, markdown.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function cleanForSpeech(text, limit = 600) {
  let body = String(text ?? '')
  body = body.replace(/```[\s\S]*?```/g, '（代码省略）')
  body = body.replace(/`([^`]+)`/g, '$1')
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  body = body.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  body = body.replace(/https?:\/\/\S+/g, '链接')
  body = body.replace(/[*_#>|]/g, '')
  body = body.replace(/\s+/g, ' ').trim()
  return body.length > limit ? `${body.slice(0, limit)}…` : body
}
