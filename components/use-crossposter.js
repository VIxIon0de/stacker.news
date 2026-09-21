import { useCallback } from 'react'
import { useToast } from './toast'
import { Button } from 'react-bootstrap'
import Nostr, { DEFAULT_CROSSPOSTING_RELAYS } from '@/lib/nostr'
import { markdownToNostrText, imetaTags } from '@/lib/nostr-content'
import { gql } from '@apollo/client'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { SETTINGS } from '@/fragments/users'
import { ITEM_FULL_FIELDS, POLL_FIELDS } from '@/fragments/items'

// `plainText` is for kind 1 events only: NIP-10 says they are plain text, so the
// markdown body is converted and its images are re-emitted as bare URLs, which
// is the only form a note client will embed. NIP-23 articles and NIP-99
// listings keep the markdown they are defined to carry.
export function itemToContent (item, { includeTitle = true, plainText = false } = {}) {
  let content = includeTitle ? item.title : ''

  if (item.url) {
    content += `\n${item.url}`
  }

  let media = []

  if (item.text) {
    if (plainText) {
      const converted = markdownToNostrText(item.text)
      media = converted.media
      if (converted.text) {
        content += `\n\n${converted.text}`
      }
    } else {
      content += `\n\n${item.text}`
    }
  }

  for (const { url } of media) {
    content += `\n\n${url}`
  }

  content += `\n\nhttps://stacker.news/items/${item.id}`

  return { content: content.trim(), media }
}

export function discussionToEvent (item) {
  const createdAt = Math.floor(Date.now() / 1000)

  // NIP-23 long-form content is markdown; it is left as authored.
  const { content } = itemToContent(item, { includeTitle: false })

  return {
    created_at: createdAt,
    kind: 30023,
    content,
    tags: [
      ['d', item.id.toString()],
      ['title', item.title],
      ['published_at', createdAt.toString()]
    ]
  }
}

export function linkToEvent (item) {
  const createdAt = Math.floor(Date.now() / 1000)

  const { content, media } = itemToContent(item, { plainText: true })

  return {
    created_at: createdAt,
    kind: 1,
    content,
    tags: imetaTags(media)
  }
}

export function pollToEvent (item) {
  const createdAt = Math.floor(Date.now() / 1000)

  const expiresAt = createdAt + 86400

  const { content, media } = itemToContent(item, { plainText: true })

  return {
    created_at: createdAt,
    kind: 1,
    content,
    tags: [
      ['poll', 'single', expiresAt.toString(), item.title, ...item.poll.options.map(op => op?.option.toString())],
      ...imetaTags(media)
    ]
  }
}

export function bountyToEvent (item) {
  const createdAt = Math.floor(Date.now() / 1000)

  // NIP-99 classified listings describe themselves in markdown.
  const { content } = itemToContent(item)

  return {
    created_at: createdAt,
    kind: 30402,
    content,
    tags: [
      ['d', item.id.toString()],
      ['title', item.title],
      ['location', `https://stacker.news/items/${item.id}`],
      ['price', item.bounty.toString(), 'SATS'],
      ['t', 'bounty'],
      ['published_at', createdAt.toString()]
    ]
  }
}

export default function useCrossposter () {
  const toaster = useToast()
  const client = useApolloClient()
  const { data } = useQuery(SETTINGS)
  const userRelays = data?.settings?.privates?.nostrRelays || []
  const relays = [...DEFAULT_CROSSPOSTING_RELAYS, ...userRelays]

  const [updateNoteId] = useMutation(
    gql`
      mutation updateNoteId($id: ID!, $noteId: String!) {
        updateNoteId(id: $id, noteId: $noteId) {
          id
          noteId
        }
      }`
  )

  const relayError = (failedRelays) => {
    return new Promise(resolve => {
      const handleSkip = () => {
        resolve('skip')

        removeToast()
      }

      const removeToast = toaster.warning(
        <>
          Crossposting failed for {failedRelays.join(', ')} <br />
          <Button
            variant='link' onClick={() => {
              resolve('retry')
              setTimeout(() => {
                removeToast()
              }, 1000)
            }}
          >Retry
          </Button>
          {' | '}
          <Button
            variant='link' onClick={handleSkip}
          >Skip
          </Button>
        </>,
        {
          onClose: () => handleSkip(),
          autohide: false
        }
      )
    })
  }

  const crosspostError = (errorMessage) => {
    return toaster.warning(`crossposting failed: ${errorMessage}`)
  }

  async function handleEventCreation (item) {
    const determineItemType = (item) => {
      const typeMap = {
        url: 'link',
        bounty: 'bounty',
        pollCost: 'poll'
      }

      for (const [key, type] of Object.entries(typeMap)) {
        if (item[key]) {
          return type
        }
      }

      // Default
      return 'discussion'
    }

    const itemType = determineItemType(item)
    switch (itemType) {
      case 'discussion':
        return discussionToEvent(item)
      case 'link':
        return linkToEvent(item)
      case 'bounty':
        return bountyToEvent(item)
      case 'poll':
        return pollToEvent(item)
      default:
        return crosspostError('Unknown item type')
    }
  }

  const fetchItemData = async (itemId) => {
    try {
      const { data } = await client.query({
        query: gql`
        ${ITEM_FULL_FIELDS}
        ${POLL_FIELDS}
        query Item($id: ID!) {
          item(id: $id) {
            ...ItemFullFields
            ...PollFields
          }
        }`,
        variables: { id: itemId },
        fetchPolicy: 'no-cache'
      })

      return data?.item
    } catch (e) {
      console.error(e)
      return null
    }
  }

  const crosspostItem = async item => {
    let failedRelays
    let allSuccessful = false
    let noteId

    const event = await handleEventCreation(item)
    if (!event) return { allSuccessful, noteId }

    do {
      const nostr = new Nostr()
      try {
        const result = await nostr.crosspost(event, { relays: failedRelays || relays })

        if (result.error) {
          failedRelays = []
          throw new Error(result.error)
        }

        noteId = result.noteId
        failedRelays = result?.failedRelays?.map(relayObj => relayObj.relay) || []

        if (failedRelays.length > 0) {
          const userAction = await relayError(failedRelays)

          if (userAction === 'skip') {
            toaster.success('Skipped failed relays.')
            // wait 2 seconds then break
            await new Promise(resolve => setTimeout(resolve, 2000))
            break
          }
        } else {
          allSuccessful = true
        }
      } catch (error) {
        await crosspostError(error.message)

        // wait 2 seconds to show error then break
        await new Promise(resolve => setTimeout(resolve, 2000))
        return { allSuccessful, noteId }
      } finally {
        nostr.close()
      }
    } while (failedRelays.length > 0)

    return { allSuccessful, noteId }
  }

  const handleCrosspost = useCallback(async (itemId) => {
    let noteId

    try {
      if (itemId) {
        const item = await fetchItemData(itemId)

        const crosspostResult = await crosspostItem(item)
        noteId = crosspostResult?.noteId
        if (noteId) {
          await updateNoteId({
            variables: {
              id: itemId,
              noteId
            }
          })
        }
      }
    } catch (e) {
      console.error(e)
      await crosspostError(e.message)
    }
  }, [updateNoteId, relays, toaster])

  return handleCrosspost
}
