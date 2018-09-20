// to-do: rather than remembering once we have a title. We should wipe
// the title state when we see title tag opened, so we only keep latest title.
// e.g.:
// <title>foo</title>
// <title>bar</title>
// we should take title as 'bar' not 'foo'

// ts-jest already adds source-maps so we don't want to add them again during tests
if (process.env.NODE_ENV !== 'test') {
  require('source-map-support').install()
}

import {
  parse as parseUrl,
  resolve as resolveUrl
} from 'url'

import { Parser } from 'htmlparser2'

import * as iconv from 'iconv-lite'
import fetch from 'node-fetch'
import UnexpectedError from './unexpectedError'
import {
  schema,
  keys
} from './schema'

type Opts = {
  /** support retreiving oembed metadata */
  oembed?: boolean
  /** req/res timeout in ms, it resets on redirect. 0 to disable (OS limit applies) */
  timeout?: number
  /** maximum redirect count. 0 to not follow redirect */
  follow?: number
  /** support gzip/deflate content encoding */
  compress?: boolean
  /** maximum response body size in bytes. 0 to disable */
  size?: number
  /** http(s).Agent instance, allows custom proxy, certificate, lookup, family etc. */
  agent?: string | null
}

type Metadata = {
  title: string,
  description: string,
  keywords: string[]
  oEmbed?: {
    type: 'photo' | 'video' | 'link' | 'rich'
    version?: string
    title?: string
    author_name?: string
    author_url?: string
    provider_name?: string
    provider_url?: string
    cache_age?: number
    thumbnails?: [{
      url?: string
      width?: number
      height?: number
    }]
  }
  twitter_card: {
    card: string
    site?: string
    creator?: string
    creator_id?: string
    title?: string
    description?: string
    players?: {
      url: string
      stream?: string
      height?: number
      width?: number
    }[]
    apps: {
      iphone: {
        id: string
        name: string
        url: string
      }
      ipad: {
        id: string
        name: string
        url: string
      }
      googleplay: {
        id: string
        name: string
        url: string
      }
    },
    images: {
      url: string
      alt: string
    }[]
  }[]
  open_graph: {
    title: string
    type: string
    images?: {
      url: string
      secure_url?: string
      type: string
      width: number
      height: number
    }[]
    url?: string
    audio?: {
      url: string
      secure_url?: string
      type: string 
    }[]
    description?: string
    determiner?: string
    locale: string
    locale_alt: string
    videos: {
      url: string
      stream?: string
      height?: number
      width?: number
      tags?: string[]
    }[]
  }[]
}

function unfurl (url: string, opts?: Opts): Promise<Metadata> {
  if (opts === undefined) {
    opts = {}
  }

  if (opts.constructor.name !== 'Object') {
    throw new UnexpectedError(UnexpectedError.BAD_OPTIONS)
  }

  // Setting defaults when not provided or not correct type
  typeof opts.oembed === 'boolean' || (opts.oembed = true)
  typeof opts.compress === 'boolean' || (opts.compress = true)
  typeof opts.agent === 'string' || (opts.agent = 'facebookexternalhit')

  Number.isInteger(opts.follow) || (opts.follow = 50)
  Number.isInteger(opts.timeout) || (opts.timeout = 0)
  Number.isInteger(opts.size) || (opts.size = 0)

  const ctx: {
    url?: string,
    oembedUrl?: string
  } = {
    url
  }

  return getPage(url, opts)
    .then(getMetadata(ctx, opts))
    .then(getRemoteMetadata(ctx, opts))
    .then(parse(ctx))
}

async function getPage (url: string, opts: Opts) {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html, application/xhtml+xml',
      agent: opts.agent
    },
    timeout: opts.timeout,
    follow: opts.follow,
    compress: opts.compress,
    size: opts.size
  })

  const buf = await res.buffer()
  const contentType = res.headers.get('Content-Type')
  const contentLength = res.headers.get('Content-Length')

  if (/text\/html|application\/xhtml+xml/.test(contentType) === false) {
    throw new UnexpectedError({ ...UnexpectedError.EXPECTED_HTML, info: { contentType, contentLength } })
  }

	// no charset in content type, peek at response body for at most 1024 bytes
  let str = buf.slice(0, 1024).toString()
  let rg

  if (contentType) {
    rg = /charset=([^;]*)/i.exec(contentType)
  }

	// html 5
  if (!rg && str) {
    rg = /<meta.+?charset=(['"])(.+?)\1/i.exec(str)
  }

  // html 4
  if (!rg && str) {
    rg = /<meta.+?content=["'].+;\s?charset=(.+?)["']/i.exec(str)
  }

	// found charset
  if (rg) {
    const supported = [ 'CP932', 'CP936', 'CP949', 'CP950', 'GB2312', 'GBK', 'GB18030', 'BIG5', 'SHIFT_JIS', 'EUC-JP' ]
    const charset = rg.pop().toUpperCase()

    if (supported.includes(charset)) {

      return iconv.decode(buf, charset).toString()
    }
  }

  return buf.toString()
}

function getRemoteMetadata (ctx, opts) {
  return async function (metadata) {
    if (!ctx._oembed) {
      return metadata
    }

    const target = resolveUrl(ctx.url, ctx._oembed.href)

    const res = await fetch(target)
    const contentType = res.headers.get('Content-Type')
    const contentLength = res.headers.get('Content-Length')

    let ret

    if (ctx._oembed.type === 'application/json+oembed' && /application\/json/.test(contentType)) {
      ret = await res.json()
    } else if (ctx._oembed.type === 'text/xml+oembed' && /text\/xml/.test(contentType)) {
      let data = await res.text()

      let rez: any = {}

      ret = await new Promise((resolve, reject) => {
        const parser = new Parser({
          onopentag: function (name, attribs) {
            if (this._is_html) {
              if (!rez.html) {
                rez.html = ''
              }

              rez.html += `<${name} `
              rez.html += Object.keys(attribs).reduce((str, k) => str + (attribs[k] ? `${k}="${attribs[k]}"` : `${k}`) + ' ', '').trim()
              rez.html += '>'
            }

            if (name === 'html') {
              this._is_html = true
            }

            this._tagname = name
          },
          ontext: function (text) {
            if (!this._text) this._text = ''
            this._text += text
          },
          onclosetag: function (tagname) {
            if (tagname === 'oembed') {
              return
            }

            if (tagname === 'html') {
              this._is_html = false
              return
            }

            if (this._is_html) {
              rez.html += this._text.trim()
              rez.html += `</${tagname}>`
            }

            rez[tagname] = this._text.trim()

            this._tagname = ''
            this._text = ''
          },
          onend: function () {
            resolve(rez)
          },
        })

        parser.write(data)
        parser.end()
      })
    }

    if (!ret) {
      return metadata
    }


    const oEmbedMetadata = Object.keys(ret)
      .map(k => ['oEmbed:' + k, ret[k]])
      .filter(([k, v]) => keys.includes(String(k))) // to-do: look into why TS complains if i don't String()



    metadata.push(...oEmbedMetadata)
    return metadata
  }
}

function getMetadata (ctx, opts: Opts) {
  return function (text) {
    const metadata = []

    return new Promise((resolve) => {
      const parser: any = new Parser({
        onend: function () {
          if (this._favicon !== null) {
            const favicon = resolveUrl(ctx.url, '/favicon.ico')
            metadata.push(['favicon', favicon])
          }
  
          resolve(metadata)
        },

        onopentagname: function (tag) {
          this._tagname = tag
        },
  
        ontext: function (text) {
          if (this._tagname === 'title') {
            // Makes sure we haven't already seen the title
            if (this._title !== null) {
              if (this._title === undefined) {
                this._title = ''
              }
  
              this._title += text
            }
          }
        },
  
        onopentag: function (name, attr) {
          if (opts.oembed && attr.href) {
            // We will handle XML and JSON with a preference towards JSON since its more efficient for us
            if (attr.type === 'text/xml+oembed' || attr.type === 'application/json+oembed') {
              if (!ctx._oembed || ctx._oembed.type === 'text/xml+oembed') { // prefer json
                ctx._oembed = attr
              }
            }
          }
  
          const prop = attr.name || attr.property || attr.rel
          const val = attr.content || attr.value
  
          if (this._favicon !== null) {
            let favicon
  
            // If url is relative we will make it absolute
            if (attr.rel === 'shortcut icon') {
              favicon = resolveUrl(ctx.url, attr.href)
            } else if (attr.rel === 'icon') {
              favicon = resolveUrl(ctx.url, attr.href)
            }
  
            if (favicon) {
              metadata.push(['favicon', favicon])
              this._favicon = null
            }
          }
  
          if (prop === 'description') {
            metadata.push(['description', val])
          }
  
          if (prop === 'keywords') {
            metadata.push(['keywords', val])
          }
  
          if (
            !prop ||
            !val ||
            keys.includes(prop) === false
          ) {
  
            return
          }
  
          metadata.push([prop, val])
        },
  
        onclosetag: function (tag) {
          this._tagname = ''
  
          // We want to parse as little as possible so finish once we see </head>
          if (tag === 'head') {
            parser.reset()
          }
  
          if (tag === 'title' && this._title !== null) {
            metadata.push(['title', this._title])
            this._title = null
          }
        }
      }, {
        decodeEntities: true
      })

      parser.write(text)
      parser.end()
    })
  }
}

function parse (ctx) {
  return function (metadata) {
    const parsed: any = {}

    let tags = []
    let lastParent

    for (let [metaKey, metaValue] of metadata) {
      const item = schema.get(metaKey)

      if (!item) {
        parsed[metaKey] = metaValue
        continue
      }

      // Special case for video tags which we want to map to each video object
      if (metaKey === 'og:video:tag') {
        tags.push(metaValue)
        continue
      }

      if (item.type === 'string') {
        metaValue = metaValue.toString()
      } else if (item.type === 'number') {
        metaValue = parseInt(metaValue, 10)
      } else if (item.type === 'url') {
        metaValue = resolveUrl(ctx.url, metaValue)
      }

      if (parsed[item.entry] === undefined) {
        parsed[item.entry] = {}
      }

      let target = parsed[item.entry]
  
      if (item.parent) {
        if (item.category) {
          if (!target[item.parent]) {
            target[item.parent] = {}
          }

          if (!target[item.parent][item.category]) {
            target[item.parent][item.category] = {}
          }

          target = target[item.parent][item.category]
        } else {
          if (Array.isArray(target[item.parent]) === false) {
            target[item.parent] = []
          }

          if (!target[item.parent][target[item.parent].length - 1]) {
            target[item.parent].push({})
          } else if ((!lastParent || item.parent === lastParent) && target[item.parent][target[item.parent].length - 1] && target[item.parent][target[item.parent].length - 1][item.name]) {
            target[item.parent].push({})
          }

          lastParent = item.parent
          target = target[item.parent][target[item.parent].length - 1]
        }
      }

      // some fields map to the same name so once nicwe have one stick with it
      target[item.name] || (target[item.name] = metaValue)

    }

    if (tags.length && parsed.open_graph.videos) {
      parsed.open_graph.videos = parsed.open_graph.videos.map(obj => ({ ...obj,
        tags
      }))
    }

    return parsed
  }
}

module.exports = unfurl