/* eslint-env jest */

import { markdownToNostrText, imetaTags, mimeFromUrl } from './nostr-content.js'

describe('markdownToNostrText', () => {
  test('strips the markers a kind 1 client would otherwise show literally', () => {
    const { text } = markdownToNostrText('## Example heading\n\nSome **bold** and _italic_ text.')
    expect(text).toBe('Example heading\n\nSome bold and italic text.')
  })

  test('keeps both the link label and its destination', () => {
    const { text } = markdownToNostrText('See the [documentation link](https://example.com/docs).')
    expect(text).toBe('See the documentation link (https://example.com/docs).')
  })

  test('does not restate a bare url as "url (url)"', () => {
    const { text } = markdownToNostrText('[https://example.com/docs](https://example.com/docs)')
    expect(text).toBe('https://example.com/docs')
  })

  test('keeps the destination when the link carries a title', () => {
    const { text } = markdownToNostrText('[docs](<https://example.com/a b> "the title")')
    expect(text).toBe('docs (https://example.com/a b)')
  })

  test('lifts images out of the body and reports them as media', () => {
    const md = 'Before.\n\n![Example image](https://m.stacker.news/1234.png)\n\nAfter.'
    const { text, media } = markdownToNostrText(md)

    // markdown image syntax never embeds in a note, so it must not survive
    expect(text).not.toContain('![')
    expect(text).not.toContain('m.stacker.news')
    expect(text).toBe('Before.\n\nAfter.')
    expect(media).toEqual([{ url: 'https://m.stacker.news/1234.png', alt: 'Example image' }])
  })

  test('keeps a null alt when the author wrote none', () => {
    expect(markdownToNostrText('![](https://m.stacker.news/1.png)').media)
      .toEqual([{ url: 'https://m.stacker.news/1.png', alt: null }])
  })

  test('reports an image used twice once', () => {
    const md = '![a](https://m.stacker.news/1.png)\n\n![a again](https://m.stacker.news/1.png)'
    expect(markdownToNostrText(md).media).toEqual([
      { url: 'https://m.stacker.news/1.png', alt: 'a' }
    ])
  })

  test('preserves list structure and code content', () => {
    const md = '- one\n- two\n\n1. first\n2. second\n\n```js\nconsole.log("hello")\n```'
    const { text } = markdownToNostrText(md)
    expect(text).toBe('- one\n- two\n\n1. first\n2. second\n\nconsole.log("hello")')
  })

  test('leaves a link written inside a code fence as the author wrote it', () => {
    const md = 'Use it like this:\n\n```md\n[label](https://example.com)\n![img](https://m.stacker.news/1.png)\n```'
    const { text, media } = markdownToNostrText(md)
    expect(text).toContain('[label](https://example.com)')
    expect(text).toContain('![img](https://m.stacker.news/1.png)')
    expect(media).toEqual([])
  })

  test('collapses the blank space left behind by a lifted image', () => {
    const md = 'One.\n\n![a](https://m.stacker.news/1.png)\n\n![b](https://m.stacker.news/2.png)\n\nTwo.'
    expect(markdownToNostrText(md).text).toBe('One.\n\nTwo.')
  })

  test('handles empty input', () => {
    expect(markdownToNostrText('')).toEqual({ text: '', media: [] })
    expect(markdownToNostrText(undefined)).toEqual({ text: '', media: [] })
    expect(markdownToNostrText('   \n\n ')).toEqual({ text: '', media: [] })
  })
})

describe('imetaTags', () => {
  test('carries the url plus a media type derived from a known extension', () => {
    expect(imetaTags([{ url: 'https://m.stacker.news/1234.png', alt: null }]))
      .toEqual([['imeta', 'url https://m.stacker.news/1234.png', 'm image/png']])
  })

  test('includes alt text when the author wrote some', () => {
    expect(imetaTags([{ url: 'https://m.stacker.news/1234.jpg', alt: 'a cat' }]))
      .toEqual([['imeta', 'url https://m.stacker.news/1234.jpg', 'm image/jpeg', 'alt a cat']])
  })

  test('emits no tag rather than inventing a field it does not know', () => {
    // NIP-92 requires a field beside the url; a hash or dimension would be fabricated
    expect(imetaTags([{ url: 'https://m.stacker.news/1234', alt: null }])).toEqual([])
  })
})

describe('mimeFromUrl', () => {
  test('ignores query strings and unknown extensions', () => {
    expect(mimeFromUrl('https://m.stacker.news/1234.webp?v=2')).toBe('image/webp')
    expect(mimeFromUrl('https://example.com/article')).toBe(null)
    expect(mimeFromUrl('not a url')).toBe(null)
  })
})
