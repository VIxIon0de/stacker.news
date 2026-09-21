/* eslint-env jest */

import { linkToEvent, discussionToEvent, bountyToEvent, pollToEvent } from './use-crossposter'

// the body from the report, minus the placeholder
const BODY = [
  '## Example heading',
  '',
  'Some **bold** text and a [documentation link](https://example.com/docs).',
  '',
  '![Example image](https://m.stacker.news/1234.png)'
].join('\n')

const item = {
  id: 1504607,
  title: 'Example title',
  url: 'https://example.com/article',
  text: BODY
}

describe('kind 1 events', () => {
  test('carry plain text, not the markdown source', () => {
    const { kind, content } = linkToEvent(item)

    expect(kind).toBe(1)
    expect(content).not.toContain('##')
    expect(content).not.toContain('**')
    expect(content).not.toContain('![')
    expect(content).toContain('Example heading')
    expect(content).toContain('Some bold text')
  })

  test('keep the destination of an inline link', () => {
    expect(linkToEvent(item).content).toContain('documentation link (https://example.com/docs)')
  })

  test('re-emit media as a bare url so clients embed it', () => {
    const { content } = linkToEvent(item)
    expect(content).toContain('\n\nhttps://m.stacker.news/1234.png\n\n')
  })

  test('describe that media with a NIP-92 imeta tag', () => {
    expect(linkToEvent(item).tags).toEqual([
      ['imeta', 'url https://m.stacker.news/1234.png', 'm image/png', 'alt Example image']
    ])
  })

  test('still carry the title, the link and the SN backlink', () => {
    const { content } = linkToEvent(item)
    expect(content.startsWith('Example title\nhttps://example.com/article')).toBe(true)
    expect(content.endsWith('https://stacker.news/items/1504607')).toBe(true)
  })

  test('add imeta after the poll tag rather than replacing it', () => {
    const poll = { ...item, poll: { options: [{ option: 'yes' }, { option: 'no' }] } }
    const { kind, tags } = pollToEvent(poll)

    expect(kind).toBe(1)
    expect(tags[0][0]).toBe('poll')
    expect(tags[tags.length - 1][0]).toBe('imeta')
  })

  test('emit no tags when the post has no media', () => {
    expect(linkToEvent({ ...item, text: 'just words' }).tags).toEqual([])
  })
})

describe('markdown kinds are left alone', () => {
  test('NIP-23 articles keep their markdown', () => {
    const { kind, content } = discussionToEvent({ ...item, url: null })

    expect(kind).toBe(30023)
    expect(content).toContain('## Example heading')
    expect(content).toContain('**bold**')
    expect(content).toContain('![Example image](https://m.stacker.news/1234.png)')
  })

  test('NIP-99 listings keep their markdown', () => {
    const { kind, content } = bountyToEvent({ ...item, bounty: 1000 })

    expect(kind).toBe(30402)
    expect(content).toContain('## Example heading')
    expect(content).toContain('![Example image](https://m.stacker.news/1234.png)')
  })
})
