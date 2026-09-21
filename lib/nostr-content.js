import removeMd from 'remove-markdown'

// NIP-10: kind 1 notes are plain text and SHOULD NOT carry markdown. SN stores
// item.text as markdown, so crossposting it verbatim leaves note clients showing
// literal `##` and `**`, and — because markdown image syntax is not a bare URL —
// embedding no media at all. NIP-23 articles (30023) and NIP-99 listings (30402)
// are defined to carry markdown and must not come through here.

// remove-markdown handles headings, emphasis and code fences, but it drops link
// destinations and reduces an image to its alt text, which is exactly the
// information a note needs to keep. Both are lifted out before it runs.
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const LINK_RE = /\[([^\]]+)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const FENCE_RE = /(?:```|~~~)[^\n]*\n?([\s\S]*?)(?:```|~~~)/g
// private-use characters so a placeholder cannot collide with authored text
const PLACEHOLDER = index => `\uE000${index}\uE001`

// Extensions whose media type we can state without inspecting the bytes.
// NIP-92 wants at least one field beside the url; a recognized extension is
// evidence, an invented hash or dimension would not be.
const MIME_BY_EXTENSION = {
  apng: 'image/apng',
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  png: 'image/png',
  svg: 'image/svg+xml',
  webm: 'video/webm',
  webp: 'image/webp'
}

export function mimeFromUrl (url) {
  try {
    const { pathname } = new URL(url)
    const extension = pathname.split('.').pop()?.toLowerCase()
    return MIME_BY_EXTENSION[extension] ?? null
  } catch {
    return null
  }
}

const unbracket = destination => destination.replace(/^<|>$/g, '')

// Fenced code is set aside before anything else runs, so a link or image
// written inside a code sample survives exactly as the author typed it.
function extractCodeFences (markdown) {
  const blocks = []
  const withoutFences = markdown.replace(FENCE_RE, (_match, code) => {
    blocks.push(code.replace(/\n$/, ''))
    return PLACEHOLDER(blocks.length - 1)
  })
  return { withoutFences, blocks }
}

function restoreCodeFences (text, blocks) {
  return blocks.reduce((acc, code, index) => acc.replaceAll(PLACEHOLDER(index), code), text)
}

/**
 * Convert SN markdown into the note body a kind 1 client can actually render,
 * plus the media it referenced.
 *
 * @param {string} markdown
 * @returns {{ text: string, media: Array<{ url: string, alt: string|null }> }}
 */
export function markdownToNostrText (markdown) {
  if (!markdown?.trim()) return { text: '', media: [] }

  const media = []
  const { withoutFences, blocks } = extractCodeFences(markdown)

  const lifted = withoutFences
    // images leave the body entirely; the caller re-emits them as bare URLs
    .replace(IMAGE_RE, (_match, alt, destination) => {
      media.push({ url: unbracket(destination), alt: alt.trim() || null })
      return ''
    })
    // a label without its destination loses where the link pointed
    .replace(LINK_RE, (_match, label, destination) => {
      const url = unbracket(destination)
      return label.trim() === url ? url : `${label} (${url})`
    })

  const text = restoreCodeFences(
    removeMd(lifted, { stripListLeaders: false, useImgAltText: false }), blocks
  )
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // an image used twice is still one attachment
  const seen = new Set()
  const deduped = media.filter(({ url }) => {
    if (!url || seen.has(url)) return false
    seen.add(url)
    return true
  })

  return { text, media: deduped }
}

/**
 * NIP-92 imeta tags. Each tag carries the url and at least one further field;
 * media we know nothing else about gets no tag rather than a fabricated one.
 * The bare URL in the content is what makes clients render it either way.
 */
export function imetaTags (media) {
  return media.map(({ url, alt }) => {
    const fields = [`url ${url}`]
    const mime = mimeFromUrl(url)
    if (mime) fields.push(`m ${mime}`)
    if (alt) fields.push(`alt ${alt}`)
    return fields.length > 1 ? ['imeta', ...fields] : null
  }).filter(Boolean)
}
